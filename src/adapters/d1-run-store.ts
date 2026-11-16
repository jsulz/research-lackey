import type {
  FinalStatus,
  Item,
  Run,
  RunRef,
  RunStatus,
  RunStore,
  Schedule,
  Source,
  TopicLastChecked,
  TopicSchedule,
} from "../core/ports";

/** SQL for the milliseconds between two ISO 8601 times, or NULL when the Run never started. */
const DURATION_MS = (ended: string, started: string) =>
  `CASE WHEN ${started} IS NULL THEN NULL
     ELSE CAST(round((julianday(${ended}) - julianday(${started})) * 86400000) AS INTEGER) END`;

/** Final statuses after which a Run's Items count as seen. */
const COMPLETED = "('completed_with_report', 'completed_no_new_findings')";

/** A seen Item of the Source bound to the first parameter: recorded by a completed Run. */
const SEEN_ITEM = `SELECT 1 FROM items i JOIN runs r ON r.id = i.first_seen_run_id
  WHERE i.source_id = ? AND r.status IN ${COMPLETED}`;

/** SQLite's error text when an insert breaks `runs_one_active_per_topic` (migration 0003). */
const ONE_ACTIVE_PER_TOPIC = "UNIQUE constraint failed: runs.topic_id";

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

  async dueTopicsInput(): Promise<TopicSchedule[]> {
    const { results } = await this.db
      .prepare(
        `SELECT t.id, t.schedule_kind, t.schedule_interval_hours, t.schedule_weekday,
                t.schedule_time_utc,
                EXISTS (
                  SELECT 1 FROM runs r
                  WHERE r.topic_id = t.id AND r.kind IN ('scheduled', 'manual')
                    AND r.status IN ('queued', 'running')
                ) AS has_active_run
         FROM topics t
         ORDER BY t.id`,
      )
      .all<{
        id: string;
        schedule_kind: Schedule["kind"];
        schedule_interval_hours: number | null;
        schedule_weekday: number | null;
        schedule_time_utc: string | null;
        has_active_run: number;
      }>();
    // The topics CHECK constraint guarantees each kind's parameters are present.
    return results.map((t) => ({
      topic_id: t.id,
      schedule: toSchedule(t),
      has_active_run: t.has_active_run === 1,
    }));
  }

  async createQueuedRun(run: RunRef): Promise<boolean> {
    // DO NOTHING covers the primary key, the one-Run-per-slot index and the
    // one-active-Run-per-Topic index.
    const { meta } = await this.db
      .prepare(
        `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status)
         VALUES (?, ?, ?, ?, 'queued')
         ON CONFLICT DO NOTHING`,
      )
      .bind(run.id, run.topic_id, run.kind, run.scheduled_slot)
      .run();
    return meta.changes === 1;
  }

  async markRunning(run: RunRef, at: Date): Promise<"running" | "topic_busy"> {
    // Manual Runs have no row until here. A retried step keeps the first start time.
    try {
      await this.markRunningRow(run, at);
      return "running";
    } catch (err) {
      if (err instanceof Error && err.message.includes(ONE_ACTIVE_PER_TOPIC)) return "topic_busy";
      throw err;
    }
  }

  private async markRunningRow(run: RunRef, at: Date): Promise<void> {
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

  async listFeedSources(topicId: string): Promise<Source[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, topic_id, format, fixture_ref FROM sources
         WHERE topic_id = ? AND kind = 'feed'
         ORDER BY id`,
      )
      .bind(topicId)
      .all<Source>();
    return results;
  }

  async unseenItemKeys(sourceId: string, keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    // Keys travel as one JSON parameter: D1 allows at most 100 bound parameters per statement.
    const { results } = await this.db
      .prepare(
        `SELECT k.value AS item_key FROM json_each(?) k
         WHERE NOT EXISTS (${SEEN_ITEM} AND i.item_key = k.value)
         ORDER BY k.key`,
      )
      .bind(JSON.stringify(keys), sourceId)
      .all<{ item_key: string }>();
    return results.map((r) => r.item_key);
  }

  async isFirstPoll(sourceId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT NOT EXISTS (${SEEN_ITEM}) AS first_poll`)
      .bind(sourceId)
      .first<{ first_poll: number }>();
    return row?.first_poll === 1;
  }

  async recordItems(runId: string, items: Item[]): Promise<void> {
    if (items.length === 0) return;
    // Takes over a row only when its recording Run did not complete (failed, or this same Run
    // on a retried step). A row from a completed Run is never changed.
    const insert = this.db.prepare(
      `INSERT INTO items
         (source_id, item_key, url, title, published_at, first_seen_run_id, content_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, item_key) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         published_at = excluded.published_at,
         first_seen_run_id = excluded.first_seen_run_id,
         content_key = excluded.content_key,
         created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE NOT EXISTS (
         SELECT 1 FROM runs r
         WHERE r.id = items.first_seen_run_id AND r.status IN ${COMPLETED}
       )`,
    );
    await this.db.batch(
      items.map((item) =>
        insert.bind(
          item.source_id,
          item.item_key,
          item.url,
          item.title,
          item.published_at,
          runId,
          item.content_key,
        ),
      ),
    );
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

function toSchedule(t: {
  schedule_kind: Schedule["kind"];
  schedule_interval_hours: number | null;
  schedule_weekday: number | null;
  schedule_time_utc: string | null;
}): Schedule {
  switch (t.schedule_kind) {
    case "every_n_hours":
      return { kind: "every_n_hours", interval_hours: Number(t.schedule_interval_hours) };
    case "daily":
      return { kind: "daily", time_utc: String(t.schedule_time_utc) };
    case "weekly":
      return {
        kind: "weekly",
        weekday: Number(t.schedule_weekday),
        time_utc: String(t.schedule_time_utc),
      };
  }
}
