import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PollRow, SOURCES_SQL, sourceHealth } from "../../scripts/sources-lib";
import { deleteRuns, deleteTestTopics } from "./cleanup";

// `npm run sources` sends SOURCES_SQL to D1 through Wrangler. Here the same statement runs
// against local D1, so the query is tested and not only the code that reads its rows.
const TOPIC = "test-sources-query";

async function addSource(id: string) {
  await env.DB.prepare(
    "INSERT INTO sources (id, topic_id, kind, format) VALUES (?, ?, 'feed', 'atom')",
  )
    .bind(id, TOPIC)
    .run();
}

/** Inserts the Run of November `day` (once) and a Poll of `source` in it. */
async function addPoll(source: string, day: number, outcome: "succeeded" | "failed") {
  const dd = String(day).padStart(2, "0");
  const run = `manual-${TOPIC}-202611${dd}T120000Z`;
  const failed = outcome === "failed";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO runs (id, topic_id, kind, status) VALUES (?, ?, 'manual', 'failed')",
    ).bind(run, TOPIC),
    env.DB.prepare(
      `INSERT INTO polls (run_id, source_id, outcome, attempts, items_read, items_new,
         failure_reason, duration_ms, created_at)
       VALUES (?, ?, ?, 1, 0, ?, ?, 0, ?)`,
    ).bind(
      run,
      source,
      outcome,
      failed ? null : day,
      failed ? "HTTP 500" : null,
      `2026-11-${dd}T12:00:44Z`,
    ),
  ]);
}

async function queryRows(): Promise<PollRow[]> {
  const { results } = await env.DB.prepare(SOURCES_SQL).all<PollRow>();
  return results.filter((r) => r.source_id.startsWith("q-"));
}

describe("SOURCES_SQL", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO topics (id, name, research_goal, schedule_kind, schedule_time_utc)
       VALUES (?, 'Sources query', 'Test', 'daily', '12:00')`,
    )
      .bind(TOPIC)
      .run();
  });

  afterEach(async () => {
    await deleteRuns();
    await deleteTestTopics();
  });

  it("returns each Source's 10 most recent Polls, newest first, and nulls for a Source with none", async () => {
    await addSource("q-busy");
    await addSource("q-new");
    // Inserted oldest last, so insertion order can't stand in for the Poll time.
    for (let day = 12; day >= 1; day--)
      await addPoll("q-busy", day, day <= 3 ? "failed" : "succeeded");

    const rows = await queryRows();

    expect(rows.filter((r) => r.source_id === "q-busy").map((r) => r.created_at)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(
        (d) => `2026-11-${String(d).padStart(2, "0")}T12:00:44Z`,
      ),
    );
    expect(rows.filter((r) => r.source_id === "q-new")).toEqual([
      { source_id: "q-new", run_id: null, outcome: null, items_new: null, created_at: null },
    ]);
    expect(rows[0]).toEqual({
      source_id: "q-busy",
      run_id: `manual-${TOPIC}-20261112T120000Z`,
      outcome: "succeeded",
      items_new: 12,
      created_at: "2026-11-12T12:00:44Z",
    });
  });

  it("gives rows that flag a Source whose last 3 Polls failed, and only that Source", async () => {
    await addSource("q-down");
    await addSource("q-up");
    for (const day of [1, 2, 3, 4]) {
      await addPoll("q-down", day, day === 1 ? "succeeded" : "failed");
      await addPoll("q-up", day, day === 4 ? "succeeded" : "failed");
    }

    const health = sourceHealth(await queryRows());

    expect(health).toEqual([
      {
        source_id: "q-down",
        last_outcome: "failed",
        last_poll_at: "2026-11-04T12:00:44Z",
        items_new: null,
        failed: 3,
        polls: 4,
        regularly_failing: true,
      },
      {
        source_id: "q-up",
        last_outcome: "succeeded",
        last_poll_at: "2026-11-04T12:00:44Z",
        items_new: 4,
        failed: 3,
        polls: 4,
        regularly_failing: false,
      },
    ]);
  });

  it("includes the seed Sources, one row each when they have no Polls", async () => {
    const { results } = await env.DB.prepare(SOURCES_SQL).all<PollRow>();

    expect(results.map((r) => r.source_id)).toEqual([
      "arxiv-serving",
      "hf-daily-papers",
      "modal-blog",
      "vllm-blog",
      "vllm-releases",
    ]);
  });
});
