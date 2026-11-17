import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import synthesisPrompt from "../../prompts/synthesis.md";
import triagePrompt from "../../prompts/triage.md";
import { D1RunStore } from "../adapters/d1-run-store";
import { FixtureSourceFetcher } from "../adapters/fixture-source-fetcher";
import { JsonLogger, parseLogLevel } from "../adapters/json-logger";
import { R2ArtifactStore } from "../adapters/r2-artifact-store";
import { CONFIG, type RunConfig } from "../core/config";
import type { ModelCallMetadata, RunRef, StepRunner } from "../core/ports";
import { priorStage } from "../core/replay";
import { parseRunParams, type ReplayParams, type RunParams } from "../core/run-ids";
import { runPipeline, type Stage } from "../core/run-pipeline";
import { buildStages } from "../core/stages";
import { createModelClient } from "./model-client-factory";

/** Prompt file texts, bundled by Wrangler's `Text` rule. Each Run stores a hash of each. */
const PROMPTS = { triage: triagePrompt, synthesis: synthesisPrompt };

/** `APP_ENV` as model call metadata: "dev" only when set so; production is the default. */
function modelEnv(value: string | undefined): ModelCallMetadata["env"] {
  return value === "dev" ? "dev" : "prod";
}

/** Retry policy for every step: 3 retries after the first attempt, 10 s doubling. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
} as const;

/**
 * One Run. A thin shell: each `StepRunner.do` is a `step.do()`; the core does the rest. A Replay
 * (local only in T1) runs from its starting stage with the alternate config it was given, and
 * its model calls are always tagged `env=dev`.
 */
export class RunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep): Promise<string> {
    const log = new JsonLogger(parseLogLevel(this.env.LOG_LEVEL));
    const store = new D1RunStore(this.env.DB);
    const clock = { now: () => new Date() };
    const artifacts = new R2ArtifactStore(this.env.ARTIFACTS);

    const parsed = parseRunParams(event.instanceId, event.payload);
    if (!parsed.ok) {
      // A scheduled Run already has a queued row. Fail it so it doesn't stay queued.
      await step.do("fail", STEP_CONFIG, () =>
        store.failRun(event.instanceId, "start", parsed.reason, clock.now()),
      );
      throw new NonRetryableError(parsed.reason);
    }

    const runner: StepRunner = {
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(name, STEP_CONFIG, fn as () => Promise<Rpc.Serializable<T>>) as Promise<T>,
    };
    const build = (config: RunConfig, model_env: ModelCallMetadata["env"]) =>
      buildStages({
        store,
        artifacts,
        fetcher: new FixtureSourceFetcher(),
        config,
        model: createModelClient(this.env, log),
        prompts: PROMPTS,
        model_env,
        clock,
      });
    const deps = { store, artifacts, step: runner, clock, log };

    if ("run" in parsed) {
      return runPipeline({
        ...deps,
        run: parsed.run,
        stages: build(CONFIG, modelEnv(this.env.APP_ENV)),
        runConfig: { config: CONFIG, prompts: PROMPTS },
      });
    }

    // A Replay: the source Run's Topic, the stages from `from_stage` on with the supplied config,
    // and the source Run's Step artifact for the stage before as the first input.
    const replay: ReplayParams = parsed.replay;
    const source = await step.do("source", STEP_CONFIG, async () => {
      const found = await store.getRun(replay.source_run_id);
      return found ? { topic_id: found.topic_id } : null;
    });
    if (!source) {
      // No Topic to record a failed Run against: the instance errors with no Run row.
      throw new NonRetryableError(`Source Run ${replay.source_run_id} not found`);
    }
    const run: RunRef = {
      id: event.instanceId,
      topic_id: source.topic_id,
      kind: "replay",
      scheduled_slot: null,
      replay: { source_run_id: replay.source_run_id, from_stage: replay.from_stage },
    };
    const all: readonly Stage[] = build(replay.config, "dev");
    const prior = priorStage(replay.from_stage);
    return runPipeline({
      ...deps,
      run,
      stages: all.slice(all.findIndex((s) => s.name === replay.from_stage)),
      firstInput: async () => {
        const artifact = await artifacts.getStepArtifact(replay.source_run_id, prior);
        if (artifact === null) {
          throw new Error(`Source Run ${replay.source_run_id} has no ${prior} Step artifact`);
        }
        return artifact.output;
      },
      runConfig: { config: replay.config, prompts: PROMPTS },
    });
  }
}
