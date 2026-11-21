import type {
  ActiveRun,
  FinalStatus,
  Item,
  Poll,
  PublicReport,
  ReportFinding,
  ReportRecord,
  Run,
  RunConfigRecord,
  RunRef,
  RunStatus,
  RunStore,
  Schedule,
  Source,
  SourcePollCounts,
  StepName,
  StepUsage,
  Topic,
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

  async listPublicReports(limit: number): Promise<PublicReport[]> {
    const rows = await this.publicReports("ORDER BY rp.published_at DESC, rp.id DESC LIMIT ?", [
      limit,
    ]);
    return rows.map(({ r2_key: _, ...report }) => report);
  }

  async getPublicReport(id: string): Promise<(PublicReport & { r2_key: string }) | null> {
    const [row] = await this.publicReports("AND rp.id = ?", [id]);
    return row ?? null;
  }

  /**
   * Public Reports whose Run ended `completed_with_report`, with tokens per model and total
   * cost. `tail` follows the shared WHERE clause: more conditions, ordering, a limit.
   */
  private async publicReports(
    tail: string,
    binds: unknown[],
  ): Promise<(PublicReport & { r2_key: string })[]> {
    const { results: rows } = await this.db
      .prepare(
        `SELECT rp.id, rp.summary, rp.finding_count, rp.r2_key, t.id AS topic_id,
                t.name AS topic_name, r.id AS run_id, r.started_at, r.ended_at, r.duration_ms,
                (SELECT coalesce(sum(cost_usd), 0) FROM run_steps WHERE run_id = r.id) AS cost_usd
         FROM reports rp
         JOIN runs r ON r.id = rp.run_id
         JOIN topics t ON t.id = rp.topic_id
         WHERE rp.public = 1
           AND r.status = 'completed_with_report'
           AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL AND r.duration_ms IS NOT NULL
         ${tail}`,
      )
      .bind(...binds)
      .all<{
        id: string;
        summary: string;
        finding_count: number;
        r2_key: string;
        topic_id: string;
        topic_name: string;
        run_id: string;
        started_at: string;
        ended_at: string;
        duration_ms: number;
        cost_usd: number;
      }>();
    if (rows.length === 0) return [];
    const runIds = rows.map((r) => r.run_id);
    const { results: tokenRows } = await this.db
      .prepare(
        `SELECT run_id, model,
                sum(input_tokens + cache_read_tokens + cache_write_tokens) AS input,
                sum(output_tokens) AS output
         FROM run_steps
         WHERE model IS NOT NULL AND run_id IN (${runIds.map(() => "?").join(", ")})
         GROUP BY run_id, model
         ORDER BY run_id, model`,
      )
      .bind(...runIds)
      .all<{ run_id: string; model: string; input: number; output: number }>();
    const tokens = new Map<string, PublicReport["tokens"]>();
    for (const t of tokenRows) {
      const list = tokens.get(t.run_id) ?? [];
      list.push({ model: t.model, input: t.input, output: t.output });
      tokens.set(t.run_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      topic: { id: r.topic_id, name: r.topic_name },
      run: {
        id: r.run_id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_ms: r.duration_ms,
      },
      tokens: tokens.get(r.run_id) ?? [],
      cost_usd: r.cost_usd,
      finding_count: r.finding_count,
      summary: r.summary,
      r2_key: r.r2_key,
    }));
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

  async activeRuns(): Promise<ActiveRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, topic_id, status, created_at FROM runs
         WHERE kind IN ('scheduled', 'manual') AND status IN ('queued', 'running')
         ORDER BY id`,
      )
      .all<ActiveRun>();
    return results;
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
        `INSERT INTO runs
           (id, topic_id, kind, scheduled_slot, source_run_id, from_stage, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'running',
           started_at = coalesce(runs.started_at, excluded.started_at)
         WHERE runs.status IN ('queued', 'running')`,
      )
      .bind(...runColumns(run), at.toISOString())
      .run();
  }

  async recordRunConfig(runId: string, record: RunConfigRecord): Promise<void> {
    await this.db
      .prepare(
        "UPDATE runs SET config_snapshot = ?, config_hash = ?, prompt_hashes = ? WHERE id = ?",
      )
      .bind(record.config_snapshot, record.config_hash, JSON.stringify(record.prompt_hashes), runId)
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
           (id, topic_id, kind, scheduled_slot, source_run_id, from_stage, status, failed_stage,
            failure_reason, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'failed',
           failed_stage = excluded.failed_stage,
           failure_reason = excluded.failure_reason,
           ended_at = excluded.ended_at,
           duration_ms = ${DURATION_MS("excluded.ended_at", "runs.started_at")}
         WHERE runs.status IN ('queued', 'running')`,
      )
      .bind(...runColumns(run), stage, reason, ended)
      .run();
  }

  async failStuckRun(
    runId: string,
    from: ActiveRun["status"],
    stage: string,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    const ended = at.toISOString();
    const { meta } = await this.db
      .prepare(
        `UPDATE runs SET
           status = 'failed', failed_stage = ?, failure_reason = ?, ended_at = ?,
           duration_ms = ${DURATION_MS("?", "started_at")}
         WHERE id = ? AND status = ?`,
      )
      .bind(stage, reason, ended, ended, runId, from)
      .run();
    return meta.changes === 1;
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

  async getTopic(topicId: string): Promise<Topic | null> {
    return this.db
      .prepare("SELECT id, name, research_goal FROM topics WHERE id = ?")
      .bind(topicId)
      .first<Topic>();
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

  async recordPolls(runId: string, polls: Poll[]): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO polls
         (run_id, source_id, outcome, attempts, items_read, failure_reason, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // One transaction: an earlier attempt's Polls go, this attempt's come in.
    await this.db.batch([
      this.db.prepare("DELETE FROM polls WHERE run_id = ?").bind(runId),
      ...polls.map((p) =>
        insert.bind(
          runId,
          p.source_id,
          p.outcome,
          p.attempts,
          p.items_read,
          p.failure_reason,
          p.duration_ms,
        ),
      ),
    ]);
  }

  async recordPollCounts(runId: string, counts: SourcePollCounts[]): Promise<void> {
    if (counts.length === 0) return;
    const update = this.db.prepare(
      "UPDATE polls SET items_new = ?, items_filtered = ? WHERE run_id = ? AND source_id = ?",
    );
    await this.db.batch(
      counts.map((c) => update.bind(c.items_new, c.items_filtered, runId, c.source_id)),
    );
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

  async recordStepArtifact(runId: string, step: StepName, artifactKey: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO run_steps (run_id, step, artifact_key) VALUES (?, ?, ?)
         ON CONFLICT (run_id, step) DO UPDATE SET artifact_key = excluded.artifact_key`,
      )
      .bind(runId, step, artifactKey)
      .run();
  }

  async recordStepUsage(runId: string, step: StepName, record: StepUsage): Promise<void> {
    const u = record.usage;
    await this.db
      .prepare(
        `INSERT INTO run_steps
           (run_id, step, model, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, step) DO UPDATE SET
           model = excluded.model,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens,
           cost_usd = excluded.cost_usd`,
      )
      .bind(
        runId,
        step,
        record.model,
        u.input_tokens,
        u.output_tokens,
        u.cache_read_input_tokens,
        u.cache_write_5m_input_tokens + u.cache_write_1h_input_tokens,
        record.cost_usd,
      )
      .run();
  }

  async saveReport(report: ReportRecord, findings: ReportFinding[]): Promise<void> {
    const db = this.db;
    const statements = [
      db
        .prepare(
          `INSERT INTO reports
             (id, run_id, topic_id, published_at, public, r2_key, summary, finding_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             published_at = excluded.published_at,
             public = excluded.public,
             r2_key = excluded.r2_key,
             summary = excluded.summary,
             finding_count = excluded.finding_count`,
        )
        .bind(
          report.id,
          report.run_id,
          report.topic_id,
          report.published_at,
          report.public ? 1 : 0,
          report.r2_key,
          report.summary,
          report.finding_count,
        ),
      // A retried publish replaces the Findings saved by an earlier attempt.
      db
        .prepare(
          "DELETE FROM finding_items WHERE finding_id IN (SELECT id FROM findings WHERE report_id = ?)",
        )
        .bind(report.id),
      db.prepare("DELETE FROM findings WHERE report_id = ?").bind(report.id),
    ];
    const insertFinding = db.prepare(
      `INSERT INTO findings (id, report_id, title, what_is_new, why_it_matters, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = db.prepare(
      "INSERT INTO finding_items (finding_id, source_id, item_key) VALUES (?, ?, ?)",
    );
    for (const f of findings) {
      statements.push(
        insertFinding.bind(f.id, report.id, f.title, f.what_is_new, f.why_it_matters, f.position),
      );
      for (const item of f.items) {
        statements.push(insertLink.bind(f.id, item.source_id, item.item_key));
      }
    }
    await db.batch(statements);
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

/** A Run's identity columns, in insert order: id, topic, kind, slot, source Run, starting stage. */
function runColumns(run: RunRef): (string | null)[] {
  return [
    run.id,
    run.topic_id,
    run.kind,
    run.scheduled_slot,
    run.replay?.source_run_id ?? null,
    run.replay?.from_stage ?? null,
  ];
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
