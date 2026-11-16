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
}

export interface PipelineDeps {
  run: RunRef;
  /** The ordered stage list. Production passes `STAGES`; tests pass trivial stages. */
  stages: readonly Stage[];
  store: RunStore;
  artifacts: ArtifactStore;
  step: StepRunner;
  clock: Clock;
  log: Logger;
}

/** Longest failure reason recorded on a Run. */
const MAX_REASON = 1000;

/**
 * Runs one Run through its stages and records its final status.
 *
 * Steps, in order: `start` (Run becomes `running`), one step per stage (runs the stage and
 * writes its Step artifact), `complete`. Each stage step returns only its artifact key, so
 * step results stay small. When a step exhausts its retries, a `fail` step records the
 * failing stage and reason, and the error is rethrown so the Workflow instance errors too.
 */
export async function runPipeline(deps: PipelineDeps): Promise<FinalStatus> {
  const { run, stages, store, artifacts, step, clock, log } = deps;
  let current = "start";
  try {
    await step.do("start", () => store.markRunning(run, clock.now()));

    let previous: StepName | null = null;
    for (const stage of stages) {
      current = stage.name;
      const prior: StepName | null = previous;
      await step.do(stage.name, async () => {
        const input = prior === null ? { topic_id: run.topic_id } : await priorOutput(prior);
        const output = await stage.run(input, { run, log });
        return artifacts.putStepArtifact(run.id, stage.name, { input, output });
      });
      previous = stage.name;
    }

    // No stage publishes a Report yet, so every successful Run ends with no new Findings.
    const status: FinalStatus = "completed_no_new_findings";
    current = "complete";
    await step.do("complete", () => store.completeRun(run.id, status, clock.now()));
    log.info("run completed", { run_id: run.id, status });
    return status;
  } catch (err) {
    const reason = errorMessage(err).slice(0, MAX_REASON);
    log.error("run failed", { run_id: run.id, step: current, reason });
    await step.do("fail", () => store.failRun(run.id, current, reason, clock.now()));
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
