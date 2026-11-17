import { runConfigRecord } from "./hashing";
import type {
  ArtifactStore,
  Clock,
  FinalStatus,
  Logger,
  RunRef,
  RunStore,
  StepName,
  StepRunner,
} from "./ports";

/** One pipeline stage. Its input is the previous stage's output, or `{ topic_id }` for the first. */
export interface Stage {
  name: StepName;
  run(input: unknown, ctx: { run: RunRef; log: Logger }): Promise<unknown>;
  /** The Run's final status implied by this stage's output, when the stage decides it. */
  outcome?(output: unknown): FinalStatus;
}

export interface PipelineDeps {
  run: RunRef;
  /** The ordered stage list. Production passes `buildStages(...)`; tests pass trivial stages. */
  stages: readonly Stage[];
  store: Pick<
    RunStore,
    "markRunning" | "recordRunConfig" | "recordStepArtifact" | "completeRun" | "failRun"
  >;
  /** Only Step artifacts: stages write their own data through their own dependencies. */
  artifacts: Pick<ArtifactStore, "putStepArtifact" | "getStepArtifact">;
  step: StepRunner;
  /** The effective config and prompt texts. The Run stores a snapshot and their hashes. */
  runConfig: { config: unknown; prompts: Record<string, string> };
  clock: Clock;
  log: Logger;
}

/** Longest failure reason recorded on a Run. */
const MAX_REASON = 1000;

/**
 * Runs one Run through its stages and records its final status.
 *
 * Steps, in order: `start` (Run becomes `running` and records its config snapshot and hashes),
 * one step per stage (runs the stage, writes its Step artifact and records it in `run_steps`),
 * `complete`. Each stage step returns only its artifact key and outcome, so step results stay
 * small. The final status is the last outcome a stage reports, else `completed_no_new_findings`. When a step exhausts its retries, a `fail` step records the
 * failing stage and reason, and the error is rethrown so the Workflow instance errors too.
 * When the Topic already has an active Run, the Run is recorded `failed` at `start` and no
 * stage runs.
 */
export async function runPipeline(deps: PipelineDeps): Promise<FinalStatus> {
  const { run, stages, store, artifacts, step, runConfig, clock, log } = deps;
  let current = "start";
  try {
    const started = await step.do("start", async () => {
      const result = await store.markRunning(run, clock.now());
      if (result === "running") {
        const record = await runConfigRecord(runConfig.config, runConfig.prompts);
        await store.recordRunConfig(run.id, record);
      }
      return result;
    });
    if (started === "topic_busy") {
      // Another scheduled or manual Run of this Topic is active. Record this one, run nothing.
      const reason = "Topic has an active Run";
      log.warn("run rejected", { run_id: run.id, reason });
      await step.do("reject", () => store.failRun(run, "start", reason, clock.now()));
      return "failed";
    }

    let previous: StepName | null = null;
    // A Run that publishes nothing ends with no new Findings; `publish` decides otherwise.
    let status: FinalStatus = "completed_no_new_findings";
    for (const stage of stages) {
      current = stage.name;
      const prior: StepName | null = previous;
      const result = await step.do(stage.name, async () => {
        const input = prior === null ? { topic_id: run.topic_id } : await priorOutput(prior);
        const output = await stage.run(input, { run, log });
        const key = await artifacts.putStepArtifact(run.id, stage.name, { input, output });
        await store.recordStepArtifact(run.id, stage.name, key);
        // Small and serializable: the step result is cached and replayed by the Workflow.
        return { artifact_key: key, outcome: stage.outcome?.(output) ?? null };
      });
      if (result.outcome) status = result.outcome;
      previous = stage.name;
    }

    current = "complete";
    await step.do("complete", () => store.completeRun(run.id, status, clock.now()));
    log.info("run completed", { run_id: run.id, status });
    return status;
  } catch (err) {
    const reason = errorMessage(err).slice(0, MAX_REASON);
    log.error("run failed", { run_id: run.id, step: current, reason });
    await step.do("fail", () => store.failRun(run, current, reason, clock.now()));
    throw err;
  }

  async function priorOutput(name: StepName): Promise<unknown> {
    const artifact = await artifacts.getStepArtifact(run.id, name);
    if (artifact === null) throw new Error(`Step artifact for ${name} is missing`);
    return artifact.output;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
