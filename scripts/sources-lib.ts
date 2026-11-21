// Source health from Poll rows. Pure: no Node imports, so tests in either runtime can load it.

/** Polls counted per Source: one Poll per Run, so this is its last 10 Runs. */
export const POLL_WINDOW = 10;

/** A Source is regularly failing when this many of its most recent Polls all failed. */
export const FAILING_STREAK = 3;

/** One row of `SOURCES_SQL`: a Source with one of its Polls, or with nulls when it has none. */
export interface PollRow {
  source_id: string;
  run_id: string | null;
  outcome: "succeeded" | "failed" | null;
  items_new: number | null;
  created_at: string | null;
}

export interface SourceHealth {
  source_id: string;
  /** Null when the Source has never been polled. */
  last_outcome: "succeeded" | "failed" | null;
  last_poll_at: string | null;
  /** Items new in the last Poll. Null when that Poll failed or its Run never counted them. */
  items_new: number | null;
  /** Failed Polls among the `polls` most recent ones. */
  failed: number;
  /** Polls counted, at most `POLL_WINDOW`. */
  polls: number;
  regularly_failing: boolean;
}

export type SourcesTarget = "remote" | "local";

export const USAGE = "usage: npm run sources [-- --local]";

/**
 * Every Source with its `POLL_WINDOW` most recent Polls, newest first. A Source with no Poll
 * comes back once, with nulls. Read-only, and a constant: nothing is interpolated into it.
 */
export const SOURCES_SQL = `SELECT s.id AS source_id, p.run_id, p.outcome, p.items_new, p.created_at
FROM sources s
LEFT JOIN (
  SELECT source_id, run_id, outcome, items_new, created_at,
         ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC, run_id DESC) AS rn
  FROM polls
) p ON p.source_id = s.id AND p.rn <= ${POLL_WINDOW}
ORDER BY s.id, p.rn`;

export interface SourcesResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `npx` with these arguments. `status` is null when the process could not be started. */
export type ExecFn = (args: readonly string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Parses `sources` arguments: none reads production D1, `--local` reads local D1. */
export function parseSourcesArgs(
  argv: readonly string[],
): { ok: true; target: SourcesTarget } | { ok: false; error: string } {
  const [first, ...rest] = argv;
  if (first !== undefined && first !== "--local") {
    return { ok: false, error: `unknown argument: ${first}` };
  }
  if (rest[0] !== undefined) return { ok: false, error: `unexpected argument: ${rest[0]}` };
  return { ok: true, target: first === "--local" ? "local" : "remote" };
}

/** The Wrangler command that reads the Poll rows from production or local D1. */
export function wranglerArgs(target: SourcesTarget): string[] {
  return [
    "wrangler",
    "d1",
    "execute",
    "research-lackey",
    target === "remote" ? "--remote" : "--local",
    "--json",
    "--command",
    SOURCES_SQL,
  ];
}

/** The rows in Wrangler's `d1 execute --json` output. Throws when it has another shape. */
export function parsePollRows(stdout: string): PollRow[] {
  const parsed: unknown = JSON.parse(stdout);
  const results = Array.isArray(parsed) && isRecord(parsed[0]) ? parsed[0].results : undefined;
  if (!Array.isArray(results)) throw new Error("no statement result");
  return results.map((row: unknown): PollRow => {
    if (!isRecord(row) || typeof row.source_id !== "string")
      throw new Error("row without a Source");
    const { source_id, run_id, outcome, items_new, created_at } = row;
    if (run_id === null && outcome === null && items_new === null && created_at === null) {
      return { source_id, run_id, outcome, items_new, created_at };
    }
    if (
      typeof run_id !== "string" ||
      (outcome !== "succeeded" && outcome !== "failed") ||
      (items_new !== null && typeof items_new !== "number") ||
      typeof created_at !== "string"
    ) {
      throw new Error(`unexpected Poll row for Source ${source_id}`);
    }
    return { source_id, run_id, outcome, items_new, created_at };
  });
}

/** Reads the Poll rows with Wrangler and returns the table, or an error and exit code. */
export function sources(argv: readonly string[], exec: ExecFn): SourcesResult {
  const args = parseSourcesArgs(argv);
  if (!args.ok) return fail(2, `${args.error}\n${USAGE}`);
  const database = `${args.target === "remote" ? "production" : "local"} D1`;

  const result = exec(wranglerArgs(args.target));
  if (result.status !== 0) {
    const how = result.status === null ? "did not run" : `exited ${result.status}`;
    const output = [result.stderr, result.stdout].map((s) => s.trim()).filter((s) => s !== "");
    return fail(1, [...output, `Could not read ${database} (wrangler ${how})`].join("\n"));
  }
  let rows: PollRow[];
  try {
    rows = parsePollRows(result.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      1,
      `Wrangler printed something other than the Poll rows (${reason}): ${result.stdout.slice(0, 300)}`,
    );
  }
  return { code: 0, stdout: formatSources(sourceHealth(rows), args.target), stderr: "" };
}

type PolledRow = PollRow & { outcome: "succeeded" | "failed"; created_at: string };

/** One record per Source, ordered by Source ID, from its most recent Polls. Row order is free. */
export function sourceHealth(rows: readonly PollRow[]): SourceHealth[] {
  const bySource = new Map<string, PolledRow[]>();
  for (const row of rows) {
    const polls = bySource.get(row.source_id) ?? [];
    if (row.outcome !== null && row.created_at !== null) polls.push(row as PolledRow);
    bySource.set(row.source_id, polls);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([source_id, all]) => {
      const polls = all
        .sort(
          (a, b) => compare(b.created_at, a.created_at) || compare(b.run_id ?? "", a.run_id ?? ""),
        )
        .slice(0, POLL_WINDOW);
      const last = polls[0];
      const streak = polls.slice(0, FAILING_STREAK);
      return {
        source_id,
        last_outcome: last?.outcome ?? null,
        last_poll_at: last?.created_at ?? null,
        items_new: last?.items_new ?? null,
        failed: polls.filter((p) => p.outcome === "failed").length,
        polls: polls.length,
        regularly_failing:
          streak.length === FAILING_STREAK && streak.every((p) => p.outcome === "failed"),
      };
    });
}

/** The table `npm run sources` prints: a heading naming the database, then one row per Source. */
export function formatSources(health: readonly SourceHealth[], target: SourcesTarget): string {
  const heading = `Sources in ${target === "remote" ? "production" : "local"} D1`;
  if (health.length === 0) return `${heading}\nNo Sources.\n`;
  const table = [
    ["Source", "Last outcome", "Last Poll", "New", `Failed (last ${POLL_WINDOW} Runs)`, "Flag"],
    ...health.map((h) => [
      printable(h.source_id),
      h.last_outcome ?? "never polled",
      h.last_poll_at === null ? "-" : printable(h.last_poll_at),
      h.items_new === null ? "-" : String(h.items_new),
      `${h.failed}/${h.polls}`,
      h.regularly_failing ? "regularly failing" : "",
    ]),
  ];
  const widths = table[0]?.map((_, col) => Math.max(...table.map((r) => r[col]?.length ?? 0)));
  const NEW = 3;
  const lines = table.map((row) =>
    row
      .map((cell, col) => {
        const width = widths?.[col] ?? 0;
        return col === NEW ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd(),
  );
  return `${[heading, ...lines].join("\n")}\n`;
}

function fail(code: number, message: string): SourcesResult {
  return { code, stdout: "", stderr: `${message}\n` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Control characters could move the terminal cursor or break the table; print them as `?`. */
function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}
