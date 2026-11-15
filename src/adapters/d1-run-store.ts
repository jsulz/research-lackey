import type { RunStatus, RunStore, TopicLastChecked } from "../core/ports";

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
}
