// Copies what a production Run's Replay needs into local D1 and R2 (`npm run replay -- --from-prod`).
// Production is only read: every Wrangler command goes through `checkCommand` before it runs.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mapLimit } from "../src/core/concurrency.ts";
import type { ReplayStage, StepName } from "../src/core/ports.ts";

const DB = "research-lackey";
const BUCKET = "research-lackey";
/** Production content downloads in flight at once. Each is one Wrangler process. */
const CONCURRENCY = 4;
/** Items named in one production `SELECT`, which keeps the statement far below D1's size limit. */
const ITEMS_PER_QUERY = 50;
const FINAL_STATUSES = ["completed_with_report", "completed_no_new_findings", "failed"];

/** Runs `wrangler <argv>` and resolves with its exit status and output. */
export type Exec = (
  argv: readonly string[],
) => Promise<{ status: number; stdout: string; stderr: string }>;

export interface CopyDeps {
  /** The production Run to copy. Must already be a valid Run ID. */
  runId: string;
  from: ReplayStage;
  exec: Exec;
  /** An existing empty directory for downloads and the SQL file. The caller removes it. */
  tmpDir: string;
  /** Receives one line per Wrangler command, tagged `[prod]` or `[local]`. */
  log: (line: string) => void;
}

/** The stages whose Step artifacts a Replay from `from` copies: every stage before it. */
export function stagesBefore(from: ReplayStage): StepName[] {
  return from === "triage" ? ["fetch", "dedupe"] : ["fetch", "dedupe", "triage"];
}

/** One path segment as `encodeURIComponent` or a Source ID can produce it. */
const KEY_SEGMENT = "[A-Za-z0-9_.!~*'()%-]+";
const ITEM_CONTENT_KEY = new RegExp(
  `^items/${KEY_SEGMENT}/${KEY_SEGMENT}/[A-Za-z0-9_-]{1,100}\\.md$`,
);

/**
 * True for an R2 key exactly as `dedupe` writes Item content:
 * `items/<source>/<encodeURIComponent(item key)>/<run id>.md`. Anything else is refused, so no
 * character that changes an object path (a separator, a backslash, `?`, `#`, a dot segment)
 * reaches Wrangler.
 */
export function isItemContentKey(key: unknown): key is string {
  if (typeof key !== "string" || !ITEM_CONTENT_KEY.test(key)) return false;
  return key.split("/").every((segment) => segment !== "." && segment !== "..");
}

/**
 * True when the Wrangler command only reads production: one `SELECT` against D1, or an R2 object
 * download. Exact shapes, so an added flag or a second statement is not a read.
 */
export function isProductionRead(argv: readonly string[]): boolean {
  if (argv.length !== 7) return false;
  const [a, b, c, d, e, f, g] = argv as [string, string, string, string, string, string, string];
  if (a === "d1") {
    return (
      b === "execute" &&
      c === DB &&
      d === "--remote" &&
      e === "--json" &&
      f === "--command" &&
      /^SELECT\s/.test(g) &&
      !g.includes(";")
    );
  }
  return a === "r2" && b === "object" && c === "get" && e === "--remote" && f === "--file";
}

/**
 * Throws unless the command names exactly one of `--local` and `--remote` and, when it names
 * `--remote`, is a production read.
 */
export function checkCommand(argv: readonly string[]): void {
  const local = argv.includes("--local");
  const remote = argv.includes("--remote");
  if (local === remote) {
    throw new Error(`Refused: a command must name --local or --remote: wrangler ${argv.join(" ")}`);
  }
  if (remote && !isProductionRead(argv)) {
    throw new Error(`Refused: not a production read: wrangler ${argv.join(" ")}`);
  }
}

type Row = Record<string, unknown>;

/**
 * A value as a SQL literal. Text outside a plain character set is written as hex, so no value can
 * end a string, start a comment or add a statement.
 */
function sqlValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    if (/^[A-Za-z0-9 _.:/@-]*$/.test(value)) return `'${value}'`;
    return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
  }
  throw new Error(`Cannot copy a value of type ${Array.isArray(value) ? "array" : typeof value}`);
}

/**
 * An insert of a production row, with its columns taken from the row. On a conflict with `key`,
 * `ignore` keeps the local row and `update` makes it equal the production row.
 */
function insertSql(table: string, row: Row, key: string[], mode: "ignore" | "update"): string {
  const columns = Object.keys(row);
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
      throw new Error(`Unexpected column name in production ${table}: ${JSON.stringify(column)}`);
    }
  }
  const rest = columns.filter((c) => !key.includes(c));
  const action =
    mode === "ignore" || rest.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(", ")}`;
  const values = columns.map((c) => sqlValue(row[c])).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values}) ON CONFLICT (${key.join(", ")}) ${action};`;
}

interface ItemRef {
  source_id: string;
  item_key: string;
  content_key: string;
}

/** The Items a Step artifact's output lists under `field`, or the reason it can't be read. */
function itemRefs(stage: StepName, artifact: unknown, field: string): ItemRef[] {
  const output = (artifact as { output?: Record<string, unknown> } | null)?.output;
  const list = output?.[field];
  if (!Array.isArray(list)) {
    throw new Error(`The ${stage} Step artifact has no output.${field} list`);
  }
  return list.map((entry: Partial<ItemRef> | null) => {
    if (typeof entry?.source_id !== "string" || typeof entry.item_key !== "string") {
      throw new Error(`The ${stage} Step artifact lists an Item without source_id and item_key`);
    }
    if (!isItemContentKey(entry.content_key)) {
      throw new Error(
        `The ${stage} Step artifact lists an Item with an unexpected content key: ${JSON.stringify(entry.content_key)}`,
      );
    }
    return {
      source_id: entry.source_id,
      item_key: entry.item_key,
      content_key: entry.content_key,
    };
  });
}

/**
 * Copies a production Run into local storage for a Replay from `from`: the Run row, its Topic and
 * Sources when local D1 lacks them, the Step artifacts before `from`, the Items those list, and
 * the Items' content. Everything is read from production before anything is written locally, and
 * D1 is written last, so a failed copy never leaves a Run row without its objects. Copying again
 * is safe: rows are upserted and objects overwritten.
 */
export async function copyFromProd(
  deps: CopyDeps,
): Promise<{ artifacts: number; items: number; objects: number }> {
  const { runId, from, exec, tmpDir, log } = deps;

  async function wrangler(argv: string[]): Promise<string> {
    checkCommand(argv);
    const remote = argv.includes("--remote");
    log(`${remote ? "[prod]" : "[local]"} wrangler ${argv.join(" ")}`);
    const result = await exec(argv);
    if (result.status !== 0) {
      const where = remote ? "production" : `local ${argv[0] === "d1" ? "D1" : "R2"}`;
      const hint =
        remote || argv[0] !== "d1"
          ? ""
          : "\nIs local D1 migrated? `npm run dev` applies the migrations.";
      throw new Error(
        `Could not ${remote ? "read" : "write"} ${where} (wrangler ${argv.slice(0, 4).join(" ")}, exit ${result.status}):\n${result.stderr || result.stdout}${hint}`,
      );
    }
    return result.stdout;
  }

  async function query(sql: string): Promise<Row[]> {
    const stdout = await wrangler(["d1", "execute", DB, "--remote", "--json", "--command", sql]);
    let results: unknown;
    try {
      results = (JSON.parse(stdout) as { results?: unknown }[])[0]?.results;
    } catch {
      results = undefined;
    }
    if (!Array.isArray(results)) throw new Error(`Unexpected output from production D1: ${stdout}`);
    return results as Row[];
  }

  /** Downloads a production object. Wrangler sends the key unescaped, so `%` is escaped here. */
  async function download(key: string, name: string): Promise<string> {
    const file = path.join(tmpDir, name);
    const remoteKey = key.replaceAll("%", "%25");
    await wrangler(["r2", "object", "get", `${BUCKET}/${remoteKey}`, "--remote", "--file", file]);
    return file;
  }

  // Production reads.
  const [run] = await query(`SELECT * FROM runs WHERE id = ${sqlValue(runId)}`);
  if (!run) throw new Error(`Run ${runId} not found in production`);
  if (run.kind === "replay" || run.source_run_id !== null) {
    throw new Error(`Run ${runId} is a Replay; copy the Run it replays instead`);
  }
  if (!FINAL_STATUSES.includes(run.status as string)) {
    throw new Error(`Run ${runId} has not ended (status ${String(run.status)})`);
  }
  const topics = await query(`SELECT * FROM topics WHERE id = ${sqlValue(run.topic_id)}`);
  const sources = await query(`SELECT * FROM sources WHERE topic_id = ${sqlValue(run.topic_id)}`);

  const objects: { key: string; file: string; contentType: string }[] = [];
  const artifacts = new Map<StepName, unknown>();
  for (const stage of stagesBefore(from)) {
    const key = `runs/${runId}/steps/${stage}.json`;
    const file = await download(key, `step-${stage}.json`);
    try {
      artifacts.set(stage, JSON.parse(readFileSync(file, "utf8")));
    } catch {
      throw new Error(`The ${stage} Step artifact is not JSON`);
    }
    objects.push({ key, file, contentType: "application/json" });
  }

  const refs = new Map<string, ItemRef>();
  const listed = [
    ...itemRefs("dedupe", artifacts.get("dedupe"), "items"),
    ...(artifacts.has("triage") ? itemRefs("triage", artifacts.get("triage"), "selected") : []),
  ];
  for (const ref of listed) refs.set(JSON.stringify([ref.source_id, ref.item_key]), ref);

  const items: Row[] = [];
  const wanted = [...refs.values()];
  for (let i = 0; i < wanted.length; i += ITEMS_PER_QUERY) {
    const where = wanted
      .slice(i, i + ITEMS_PER_QUERY)
      .map((r) => `(source_id = ${sqlValue(r.source_id)} AND item_key = ${sqlValue(r.item_key)})`)
      .join(" OR ");
    items.push(...(await query(`SELECT * FROM items WHERE ${where}`)));
  }
  const found = new Set(items.map((row) => JSON.stringify([row.source_id, row.item_key])));
  const missing = [...refs.keys()].find((id) => !found.has(id));
  if (missing !== undefined) throw new Error(`Item ${missing} has no row in production`);

  // An Item taken over by another Run names that Run, and the local foreign key needs its row.
  const otherRunIds = [...new Set(items.map((row) => row.first_seen_run_id))].filter(
    (id) => id !== runId,
  );
  const otherRuns =
    otherRunIds.length === 0
      ? []
      : await query(`SELECT * FROM runs WHERE id IN (${otherRunIds.map(sqlValue).join(", ")})`);
  // An active Run copied without its Workflow instance would hold the Topic's one active slot.
  const active = otherRuns.find((row) => !FINAL_STATUSES.includes(row.status as string));
  if (active) {
    throw new Error(
      `Run ${String(active.id)} has not ended (status ${String(active.status)}); it holds an Item this Run lists. Copy again when it ends`,
    );
  }

  const contentKeys = [...new Set(wanted.map((r) => r.content_key))];
  const contents = await mapLimit(contentKeys, CONCURRENCY, async (key, i) => ({
    key,
    file: await download(key, `content-${i}.md`),
    contentType: "text/markdown; charset=utf-8",
  }));
  objects.push(...contents);

  // Local writes: objects first, then every row in one file. One at a time: local Wrangler
  // processes share one storage directory, and concurrent ones fail.
  for (const o of objects) {
    await wrangler([
      "r2",
      "object",
      "put",
      `${BUCKET}/${o.key}`,
      "--local",
      "--file",
      o.file,
      "--content-type",
      o.contentType,
    ]);
  }
  const sql = [
    ...topics.map((row) => insertSql("topics", row, ["id"], "ignore")),
    ...sources.map((row) => insertSql("sources", row, ["id"], "ignore")),
    ...otherRuns.map((row) => insertSql("runs", row, ["id"], "ignore")),
    insertSql("runs", run, ["id"], "update"),
    ...items.map((row) => insertSql("items", row, ["source_id", "item_key"], "update")),
  ];
  const sqlFile = path.join(tmpDir, "copy.sql");
  writeFileSync(sqlFile, `${sql.join("\n")}\n`);
  await wrangler(["d1", "execute", DB, "--local", "--file", sqlFile]);

  return { artifacts: artifacts.size, items: items.length, objects: objects.length };
}
