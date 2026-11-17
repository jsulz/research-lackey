import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import synthesisPrompt from "../../prompts/synthesis.md";
import triagePrompt from "../../prompts/triage.md";
import { D1RunStore } from "../adapters/d1-run-store";
import { FixtureSourceFetcher } from "../adapters/fixture-source-fetcher";
import { JsonLogger, parseLogLevel } from "../adapters/json-logger";
import { R2ArtifactStore } from "../adapters/r2-artifact-store";
import { CONFIG } from "../core/config";
import type { ModelCallMetadata, StepRunner } from "../core/ports";
import { parseRunParams, type RunParams } from "../core/run-ids";
import { runPipeline } from "../core/run-pipeline";
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

/** One Run. A thin shell: each `StepRunner.do` is a `step.do()`; the core does the rest. */
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
    return runPipeline({
      run: parsed.run,
      stages: buildStages({
        store,
        artifacts,
        fetcher: new FixtureSourceFetcher(),
        config: CONFIG,
        model: createModelClient(this.env, log),
        prompts: PROMPTS,
        model_env: modelEnv(this.env.APP_ENV),
        clock,
      }),
      store,
      artifacts,
      step: runner,
      runConfig: { config: CONFIG, prompts: PROMPTS },
      clock,
      log,
    });
  }
}
