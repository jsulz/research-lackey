import { describe, expect, it } from "vitest";
import {
  formatSources,
  type PollRow,
  parsePollRows,
  parseSourcesArgs,
  SOURCES_SQL,
  sourceHealth,
  sources,
  USAGE,
} from "../../scripts/sources-lib";

/** A Poll row as the query returns it. `day` is the day of November 2026 the Run ran. */
function poll(
  source_id: string,
  day: number,
  outcome: "succeeded" | "failed",
  items_new: number | null = outcome === "succeeded" ? 0 : null,
): PollRow {
  const dd = String(day).padStart(2, "0");
  return {
    source_id,
    run_id: `topic-ai-infra-202611${dd}T1200Z`,
    outcome,
    items_new,
    created_at: `2026-11-${dd}T12:00:44Z`,
  };
}

/** The row the query returns for a Source that has no Poll. */
function unpolled(source_id: string): PollRow {
  return { source_id, run_id: null, outcome: null, items_new: null, created_at: null };
}

describe("formatSources", () => {
  it("prints one row per Source: last outcome, last Poll time, new Items and failures", () => {
    const rows = [
      poll("vllm-blog", 22, "failed"),
      poll("vllm-blog", 21, "failed"),
      poll("vllm-blog", 20, "failed"),
      poll("arxiv-serving", 22, "succeeded", 12),
      poll("arxiv-serving", 21, "failed"),
      unpolled("new-source"),
    ];

    expect(formatSources(sourceHealth(rows), "remote")).toBe(
      [
        "Sources in production D1",
        "Source         Last outcome  Last Poll             New  Failed (last 10 Runs)  Flag",
        "arxiv-serving  succeeded     2026-11-22T12:00:44Z   12  1/2",
        "new-source     never polled  -                       -  0/0",
        "vllm-blog      failed        2026-11-22T12:00:44Z    -  3/3                    regularly failing",
        "",
      ].join("\n"),
    );
  });
});

describe("sourceHealth", () => {
  it("reports a Poll whose new Items were never counted as uncounted, not zero", () => {
    const [health] = sourceHealth([poll("a", 22, "succeeded", null)]);

    expect(health).toMatchObject({ last_outcome: "succeeded", items_new: null });
    expect(formatSources(sourceHealth([poll("a", 22, "succeeded", null)]), "local")).toBe(
      [
        "Sources in local D1",
        "Source  Last outcome  Last Poll             New  Failed (last 10 Runs)  Flag",
        "a       succeeded     2026-11-22T12:00:44Z    -  0/1",
        "",
      ].join("\n"),
    );
  });

  it("counts failures over the 10 most recent Polls only", () => {
    // Days 1 to 12; days 1, 2 and 3 failed, and only day 3 is among the last 10.
    const rows = Array.from({ length: 12 }, (_, i) =>
      poll("a", i + 1, i < 3 ? "failed" : "succeeded"),
    );

    expect(sourceHealth(rows)).toEqual([
      {
        source_id: "a",
        last_outcome: "succeeded",
        last_poll_at: "2026-11-12T12:00:44Z",
        items_new: 0,
        failed: 1,
        polls: 10,
        regularly_failing: false,
      },
    ]);
  });

  it("takes the newest Poll as the last one whatever order the rows arrive in", () => {
    const rows = [poll("a", 20, "failed"), poll("a", 22, "succeeded", 4), poll("a", 21, "failed")];

    expect(sourceHealth(rows)[0]).toMatchObject({
      last_outcome: "succeeded",
      last_poll_at: "2026-11-22T12:00:44Z",
      items_new: 4,
      failed: 2,
      polls: 3,
    });
  });

  it("says so when there are no Sources", () => {
    expect(formatSources(sourceHealth([]), "remote")).toBe(
      "Sources in production D1\nNo Sources.\n",
    );
  });

  it("prints control characters in a Source ID as question marks", () => {
    const out = formatSources(sourceHealth([unpolled("a\u001b[2Jb\nc")]), "remote");

    expect(out).toContain("a?[2Jb?c  never polled");
  });
});

describe("regularly failing", () => {
  const flagged = (rows: PollRow[]) => sourceHealth(rows)[0]?.regularly_failing;

  it("flags a Source whose last 3 Polls all failed", () => {
    expect(
      flagged([
        poll("a", 22, "failed"),
        poll("a", 21, "failed"),
        poll("a", 20, "failed"),
        poll("a", 19, "succeeded"),
      ]),
    ).toBe(true);
  });

  it("does not flag when one of the last 3 Polls succeeded", () => {
    expect(
      flagged([poll("a", 22, "failed"), poll("a", 21, "succeeded"), poll("a", 20, "failed")]),
    ).toBe(false);
  });

  it("does not flag 3 failures that a newer success follows", () => {
    expect(
      flagged([
        poll("a", 22, "succeeded"),
        poll("a", 21, "failed"),
        poll("a", 20, "failed"),
        poll("a", 19, "failed"),
      ]),
    ).toBe(false);
  });

  it("does not flag a Source with fewer than 3 Polls, even when all failed", () => {
    expect(flagged([poll("a", 22, "failed"), poll("a", 21, "failed")])).toBe(false);
  });

  it("does not flag a Source that was never polled", () => {
    expect(flagged([unpolled("a")])).toBe(false);
  });
});

describe("parseSourcesArgs", () => {
  it("reads production D1 by default", () => {
    expect(parseSourcesArgs([])).toEqual({ ok: true, target: "remote" });
  });

  it("reads local D1 with --local", () => {
    expect(parseSourcesArgs(["--local"])).toEqual({ ok: true, target: "local" });
  });

  it.each([
    [["--remote"], "unknown argument: --remote"],
    [["--local", "--local"], "unexpected argument: --local"],
    [["vllm-blog"], "unknown argument: vllm-blog"],
    [["--local", "x"], "unexpected argument: x"],
    [[""], "unknown argument: "],
  ])("rejects %j", (argv, error) => {
    expect(parseSourcesArgs(argv)).toEqual({ ok: false, error });
  });
});

/** Wrangler's `d1 execute --json` output for one statement. */
function wranglerJson(results: unknown): string {
  return JSON.stringify([{ results, success: true, meta: { rows_read: 5 } }]);
}

/** A fake Wrangler that records the argument lists it was run with and answers once. */
function fakeExec(result: { status: number | null; stdout?: string; stderr?: string }) {
  const calls: string[][] = [];
  const fn = (args: readonly string[]) => {
    calls.push([...args]);
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { fn, calls };
}

describe("sources", () => {
  const ROWS = [poll("vllm-blog", 22, "succeeded", 2), unpolled("modal-blog")];

  it("queries production D1 by default and prints the table", () => {
    const exec = fakeExec({ status: 0, stdout: wranglerJson(ROWS) });

    const result = sources([], exec.fn);

    expect(exec.calls).toEqual([
      [
        "wrangler",
        "d1",
        "execute",
        "research-lackey",
        "--remote",
        "--json",
        "--command",
        SOURCES_SQL,
      ],
    ]);
    expect(result).toEqual({
      code: 0,
      stdout: [
        "Sources in production D1",
        "Source      Last outcome  Last Poll             New  Failed (last 10 Runs)  Flag",
        "modal-blog  never polled  -                       -  0/0",
        "vllm-blog   succeeded     2026-11-22T12:00:44Z    2  0/1",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("queries local D1 with --local", () => {
    const exec = fakeExec({ status: 0, stdout: wranglerJson(ROWS) });

    const result = sources(["--local"], exec.fn);

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toContain("--local");
    expect(exec.calls[0]).not.toContain("--remote");
    expect(result.stdout).toMatch(/^Sources in local D1\n/);
  });

  it("prints the usage and runs nothing for an unknown argument", () => {
    const exec = fakeExec({ status: 0, stdout: wranglerJson(ROWS) });

    const result = sources(["--prod"], exec.fn);

    expect(exec.calls).toEqual([]);
    expect(result).toEqual({ code: 2, stdout: "", stderr: `unknown argument: --prod\n${USAGE}\n` });
  });

  it("exits 1 with Wrangler's output when Wrangler fails", () => {
    const exec = fakeExec({ status: 1, stdout: '{"error":"x"}', stderr: "Not logged in.\n" });

    const result = sources([], exec.fn);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Not logged in.");
    expect(result.stderr).toContain('{"error":"x"}');
    expect(result.stderr).toContain("Could not read production D1 (wrangler exited 1)");
  });

  it("exits 1 when Wrangler could not be started", () => {
    const result = sources(["--local"], fakeExec({ status: null, stderr: "spawn npx ENOENT" }).fn);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not read local D1 (wrangler did not run)");
    expect(result.stderr).toContain("spawn npx ENOENT");
  });

  it.each([
    ["text that is not JSON", "Proxy environment variables detected."],
    ["no statement result", "[]"],
    ["a result without rows", JSON.stringify([{ success: true }])],
    ["a row without a Source ID", wranglerJson([{ ...poll("a", 22, "failed"), source_id: null }])],
    ["an unknown outcome", wranglerJson([{ ...poll("a", 22, "failed"), outcome: "skipped" }])],
    ["a Poll without a time", wranglerJson([{ ...poll("a", 22, "failed"), created_at: null }])],
    [
      "a count that is not a number",
      wranglerJson([{ ...poll("a", 22, "succeeded"), items_new: "2" }]),
    ],
  ])("exits 1 when Wrangler prints %s", (_, stdout) => {
    const result = sources([], fakeExec({ status: 0, stdout }).fn);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Wrangler printed something other than the Poll rows");
  });
});

describe("parsePollRows", () => {
  it("keeps only the fields the table uses", () => {
    const rows = parsePollRows(wranglerJson([{ ...poll("a", 22, "failed"), extra: 1 }]));

    expect(rows).toEqual([poll("a", 22, "failed")]);
  });
});
