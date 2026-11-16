import type {
  FinalStatus,
  Run,
  RunRef,
  RunStatus,
  RunStore,
  TopicLastChecked,
} from "../core/ports";

/** SQL for the milliseconds between two ISO 8601 times, or NULL when the Run never started. */
const DURATION_MS = (ended: string, started: string) =>
  `CASE WHEN ${started} IS NULL THEN NULL
     ELSE CAST(round((julianday(${ended}) - julianday(${started})) * 86400000) AS INTEGER) END`;

/** RunStore backed by D1 with hand-written SQL (ADR-0005). */
export class D1RunStore implements RunStore {
  constructor(private readonly db: D1Database) {}

  async listTopicsLastChecked(): Promise<TopicLastChecked[]> {
    const { results } = await this.db
      .prepare(
        `SELECT t.id, t.name, r.created_at AS last_checked_at, r.status AS last_run_status
         FROM topics t
         LEFT JOIN runs r ON r.id = (
           SELECT id FROM runs
           WHERE topic_id = t.id AND kind != 'replay'
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         )
         ORDER BY t.name`,
      )
      .all<{
        id: string;
        name: string;
        last_checked_at: string | null;
        last_run_status: RunStatus | null;
      }>();
    return results;
  }

  async createQueuedRun(run: RunRef): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status)
         VALUES (?, ?, ?, ?, 'queued')`,
      )
      .bind(run.id, run.topic_id, run.kind, run.scheduled_slot)
      .run();
  }

  async markRunning(run: RunRef, at: Date): Promise<void> {
    // Manual Runs have no row until here. A retried step keeps the first start time.
    await this.db
      .prepare(
        `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'running',
           started_at = coalesce(runs.started_at, excluded.started_at)
         WHERE runs.status IN ('queued', 'running')`,
      )
      .bind(run.id, run.topic_id, run.kind, run.scheduled_slot, at.toISOString())
      .run();
  }

  async completeRun(runId: string, status: FinalStatus, at: Date): Promise<void> {
    await this.end(runId, status, null, null, at, "('running')");
  }

  async failRun(run: RunRef | string, stage: string, reason: string, at: Date): Promise<void> {
    if (typeof run === "string") {
      await this.end(run, "failed", stage, reason, at, "('queued', 'running')");
      return;
    }
    const ended = at.toISOString();
    await this.db
      .prepare(
        `INSERT INTO runs
           (id, topic_id, kind, scheduled_slot, status, failed_stage, failure_reason, ended_at)
         VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'failed',
           failed_stage = excluded.failed_stage,
           failure_reason = excluded.failure_reason,
           ended_at = excluded.ended_at,
           duration_ms = ${DURATION_MS("excluded.ended_at", "runs.started_at")}
         WHERE runs.status IN ('queued', 'running')`,
      )
      .bind(run.id, run.topic_id, run.kind, run.scheduled_slot, stage, reason, ended)
      .run();
  }

  async getRun(runId: string): Promise<Run | null> {
    return this.db
      .prepare(
        `SELECT id, topic_id, kind, scheduled_slot, status, failed_stage, failure_reason,
                created_at, started_at, ended_at, duration_ms
         FROM runs WHERE id = ?`,
      )
      .bind(runId)
      .first<Run>();
  }

  /** Sets a final status on a Run whose status is in `from`. Duration counts from `started_at`. */
  private async end(
    runId: string,
    status: FinalStatus,
    stage: string | null,
    reason: string | null,
    at: Date,
    from: "('running')" | "('queued', 'running')",
  ): Promise<void> {
    const ended = at.toISOString();
    await this.db
      .prepare(
        `UPDATE runs SET
           status = ?, failed_stage = ?, failure_reason = ?, ended_at = ?,
           duration_ms = ${DURATION_MS("?", "started_at")}
         WHERE id = ? AND status IN ${from}`,
      )
      .bind(status, stage, reason, ended, ended, runId)
      .run();
  }
}
