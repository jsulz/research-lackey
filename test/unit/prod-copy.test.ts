import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCommand,
  copyFromProd,
  type Exec,
  isItemContentKey,
  isProductionRead,
  stagesBefore,
} from "../../scripts/prod-copy";

// The fake Wrangler runs each command against two real SQLite databases (production and local,
// both with every migration applied) and two in-memory buckets, so the SQL the copy writes is
// executed, not pattern-matched.

const RUN = "topic-ai-infra-20261117T1200Z";
const OLDER_RUN = "topic-ai-infra-20261116T1200Z";
const HOSTILE_KEY = "x'; DROP TABLE runs; --";

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = path.resolve("migrations");
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(path.join(dir, file), "utf8"));
  return db;
}

function contentKey(sourceId: string, itemKey: string, runId: string): string {
  return `items/${sourceId}/${encodeURIComponent(itemKey)}/${runId}.md`;
}

const ITEMS = [
  { source_id: "vllm-releases", item_key: "tag:github.com,2008:Repository/1/v0.34.0", run: RUN },
  { source_id: "vllm-blog", item_key: "https://vllm.ai/blog/a", run: RUN },
  // Recorded by an earlier Run, and with a key that would break naive SQL quoting.
  { source_id: "modal-blog", item_key: HOSTILE_KEY, run: OLDER_RUN },
].map((i) => ({
  source_id: i.source_id,
  item_key: i.item_key,
  url: `https://example.com/${encodeURIComponent(i.item_key)}`,
  title: `Title; with 'quotes' -- and\nnewline for ${i.source_id}`,
  summary: null,
  published_at: "2026-11-17T08:00:00Z",
  content_key: contentKey(i.source_id, i.item_key, i.run),
  first_seen_run_id: i.run,
}));
const passed = ITEMS.map(({ first_seen_run_id: _run, ...item }) => item);

interface Fake {
  exec: Exec;
  calls: string[][];
  prodDb: DatabaseSync;
  localDb: DatabaseSync;
  prodR2: Map<string, string>;
  localR2: Map<string, { body: string; contentType: string | undefined }>;
}

function fake(): Fake {
  const prodDb = migrated();
  const localDb = migrated();
  const prodR2 = new Map<string, string>();
  const localR2: Fake["localR2"] = new Map();
  const calls: string[][] = [];

  const insertRun = prodDb.prepare(
    `INSERT INTO runs (id, topic_id, kind, scheduled_slot, status, started_at, ended_at, duration_ms,
       config_snapshot, config_hash, prompt_hashes)
     VALUES (?, 'ai-infra', 'scheduled', ?, 'completed_with_report', ?, ?, 1234.5, '{"k":1}', 'abc',
       '{"synthesis":"prod-hash","triage":"t"}')`,
  );
  insertRun.run(OLDER_RUN, "2026-11-16T12:00:00Z", "2026-11-16T12:00:01Z", "2026-11-16T12:00:09Z");
  insertRun.run(RUN, "2026-11-17T12:00:00Z", "2026-11-17T12:00:01Z", "2026-11-17T12:00:09Z");
  const insertItem = prodDb.prepare(
    `INSERT INTO items (source_id, item_key, url, title, published_at, first_seen_run_id, content_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const i of ITEMS) {
    insertItem.run(
      i.source_id,
      i.item_key,
      i.url,
      i.title,
      i.published_at,
      i.first_seen_run_id,
      i.content_key,
    );
    prodR2.set(i.content_key, `content of ${i.item_key}`);
  }
  prodR2.set(
    `runs/${RUN}/steps/fetch.json`,
    JSON.stringify({ input: {}, output: { sources: [] } }),
  );
  prodR2.set(
    `runs/${RUN}/steps/dedupe.json`,
    JSON.stringify({ input: {}, output: { recorded: 3, passed: 3, items: passed } }),
  );
  prodR2.set(
    `runs/${RUN}/steps/triage.json`,
    JSON.stringify({ input: {}, output: { scored: [], selected: passed.slice(0, 2) } }),
  );

  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const flag = (name: string) => argv[argv.indexOf(name) + 1] as string;
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    const remote = argv.includes("--remote");
    const [a, b, c, target] = argv;
    if (a === "d1" && b === "execute") {
      const db = remote ? prodDb : localDb;
      if (argv.includes("--command")) {
        const results = db.prepare(flag("--command")).all();
        return ok(JSON.stringify([{ results, success: true }]));
      }
      try {
        db.exec(readFileSync(flag("--file"), "utf8"));
      } catch (err) {
        return { status: 1, stdout: "", stderr: String(err) };
      }
      return ok();
    }
    if (a === "r2" && b === "object" && c === "get" && target) {
      // Wrangler does not escape the key for the remote API, which decodes it once.
      const raw = target.slice("research-lackey/".length);
      const body = remote ? prodR2.get(decodeURIComponent(raw)) : localR2.get(raw)?.body;
      if (body === undefined) return { status: 1, stdout: "", stderr: "key does not exist" };
      writeFileSync(flag("--file"), body);
      return ok();
    }
    if (a === "r2" && b === "object" && c === "put" && target && !remote) {
      localR2.set(target.slice("research-lackey/".length), {
        body: readFileSync(flag("--file"), "utf8"),
        contentType: argv.includes("--content-type") ? flag("--content-type") : undefined,
      });
      return ok();
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
  return { exec, calls, prodDb, localDb, prodR2, localR2 };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "prod-copy-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function copy(f: Fake, from: "triage" | "synthesis" = "synthesis", runId = RUN) {
  return copyFromProd({ runId, from, exec: f.exec, tmpDir: tmp, log: () => {} });
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("copyFromProd", () => {
  it("copies the Run, the Step artifacts before synthesis, their Items and content", async () => {
    const f = fake();

    await copy(f);

    expect(f.localDb.prepare("SELECT * FROM runs WHERE id = ?").get(RUN)).toEqual(
      f.prodDb.prepare("SELECT * FROM runs WHERE id = ?").get(RUN),
    );
    expect(f.localDb.prepare("SELECT * FROM items ORDER BY source_id").all()).toEqual(
      f.prodDb.prepare("SELECT * FROM items ORDER BY source_id").all(),
    );
    // The earlier Run is copied because an Item names it as first seen.
    expect(count(f.localDb, "runs")).toBe(2);
    for (const stage of ["fetch", "dedupe", "triage"]) {
      const key = `runs/${RUN}/steps/${stage}.json`;
      expect(f.localR2.get(key)).toEqual({
        body: f.prodR2.get(key),
        contentType: "application/json",
      });
    }
    for (const item of ITEMS) {
      expect(f.localR2.get(item.content_key)).toEqual({
        body: `content of ${item.item_key}`,
        contentType: "text/markdown; charset=utf-8",
      });
    }
    expect(f.localR2.size).toBe(6);
  });

  it("copies only the fetch and dedupe Step artifacts for a Replay from triage", async () => {
    const f = fake();

    await copy(f, "triage");

    const steps = [...f.localR2.keys()].filter((k) => k.startsWith("runs/")).sort();
    expect(steps).toEqual([`runs/${RUN}/steps/dedupe.json`, `runs/${RUN}/steps/fetch.json`]);
    expect(count(f.localDb, "items")).toBe(3);
  });

  it("inserts the Topic and its Sources when local D1 lacks them", async () => {
    const f = fake();
    f.localDb.exec("DELETE FROM sources; DELETE FROM topics;");

    await copy(f);

    expect(f.localDb.prepare("SELECT * FROM topics").all()).toEqual(
      f.prodDb.prepare("SELECT * FROM topics").all(),
    );
    expect(f.localDb.prepare("SELECT * FROM sources ORDER BY id").all()).toEqual(
      f.prodDb.prepare("SELECT * FROM sources ORDER BY id").all(),
    );
  });

  it("a second copy succeeds and leaves one copy of each row", async () => {
    const f = fake();
    await copy(f);
    const tables = ["topics", "sources", "runs", "items"];
    const before = tables.map((t) => count(f.localDb, t));
    // Local changes between copies: the Topic edit stays, the Item row goes back to production's.
    f.localDb.exec("UPDATE topics SET name = 'Edited locally'");
    f.localDb.exec("UPDATE items SET title = 'changed' WHERE source_id = 'vllm-blog'");

    await copy(f);

    expect(tables.map((t) => count(f.localDb, t))).toEqual(before);
    expect(f.localDb.prepare("SELECT name FROM topics").get()).toEqual({ name: "Edited locally" });
    expect(f.localDb.prepare("SELECT * FROM items ORDER BY source_id").all()).toEqual(
      f.prodDb.prepare("SELECT * FROM items ORDER BY source_id").all(),
    );
    expect(f.localR2.size).toBe(6);
  });

  it("keeps a local Finding that cites a copied Item", async () => {
    const f = fake();
    await copy(f);
    f.localDb.exec(`
      INSERT INTO reports (id, run_id, topic_id, published_at, public, r2_key, summary, finding_count)
        VALUES ('rpt', '${RUN}', 'ai-infra', '2026-11-17T12:00:09Z', 0, 'k', 's', 1);
      INSERT INTO findings (id, report_id, title, what_is_new, why_it_matters, position)
        VALUES ('fnd', 'rpt', 't', 'w', 'y', 1);
      INSERT INTO finding_items (finding_id, source_id, item_key)
        VALUES ('fnd', 'vllm-blog', 'https://vllm.ai/blog/a');`);

    await copy(f);

    expect(count(f.localDb, "finding_items")).toBe(1);
  });

  it("issues only reads against production, and escapes % in remote R2 keys only", async () => {
    const f = fake();

    await copy(f);

    const remote = f.calls.filter((c) => c.includes("--remote"));
    const local = f.calls.filter((c) => c.includes("--local"));
    expect(remote.length + local.length).toBe(f.calls.length);
    expect(remote.every(isProductionRead)).toBe(true);
    // 5 D1 reads (Run, Topic, Sources, Items, first-seen Runs), 3 artifacts, 3 content objects.
    expect(remote.filter((c) => c[0] === "d1")).toHaveLength(5);
    expect(remote.filter((c) => c[0] === "r2")).toHaveLength(6);
    expect(local.filter((c) => c[0] === "r2" && c[2] === "put")).toHaveLength(6);
    expect(local.filter((c) => c[0] === "d1")).toHaveLength(1);
    const key = ITEMS[1]?.content_key as string;
    expect(remote.some((c) => c[3] === `research-lackey/${key.replaceAll("%", "%25")}`)).toBe(true);
    expect(local.some((c) => c[3] === `research-lackey/${key}`)).toBe(true);
    // Every production read happens before the first local write.
    const firstLocal = f.calls.findIndex((c) => c.includes("--local"));
    expect(f.calls.slice(firstLocal).every((c) => c.includes("--local"))).toBe(true);
    // The hostile Item key reached production inside a single SELECT, and production is intact.
    expect(count(f.prodDb, "runs")).toBe(2);
  });

  it("runs local writes one at a time: local Wrangler processes share one storage directory", async () => {
    const f = fake();
    let inFlight = 0;
    let overlapped = false;
    const exec: Exec = async (argv) => {
      if (!argv.includes("--local")) return f.exec(argv);
      inFlight += 1;
      overlapped ||= inFlight > 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const result = await f.exec(argv);
      inFlight -= 1;
      return result;
    };

    await copyFromProd({ runId: RUN, from: "synthesis", exec, tmpDir: tmp, log: () => {} });

    expect(overlapped).toBe(false);
    expect(f.localR2.size).toBe(6);
  });

  it.each([
    ["an unknown Run", (_f: Fake) => {}, "replay-nope", /not found in production/],
    [
      "a Run that has not ended",
      (f: Fake) => f.prodDb.exec(`UPDATE runs SET status = 'running' WHERE id = '${RUN}'`),
      RUN,
      /has not ended/,
    ],
    [
      "an Item first seen by a Run that has not ended",
      (f: Fake) => f.prodDb.exec(`UPDATE runs SET status = 'running' WHERE id = '${OLDER_RUN}'`),
      RUN,
      new RegExp(`${OLDER_RUN} has not ended`),
    ],
    [
      "a Replay",
      (f: Fake) =>
        f.prodDb.exec(
          `UPDATE runs SET kind = 'replay', scheduled_slot = NULL, source_run_id = '${OLDER_RUN}',
             from_stage = 'triage' WHERE id = '${RUN}'`,
        ),
      RUN,
      /is a Replay/,
    ],
    [
      "a missing Step artifact",
      (f: Fake) => f.prodR2.delete(`runs/${RUN}/steps/triage.json`),
      RUN,
      /triage\.json/,
    ],
    [
      "a Step artifact that is not JSON",
      (f: Fake) => f.prodR2.set(`runs/${RUN}/steps/dedupe.json`, "<html>"),
      RUN,
      /dedupe Step artifact/,
    ],
    [
      "a dedupe artifact without Items",
      (f: Fake) => f.prodR2.set(`runs/${RUN}/steps/dedupe.json`, JSON.stringify({ output: {} })),
      RUN,
      /dedupe Step artifact/,
    ],
    [
      "an Item with a content key outside items/",
      (f: Fake) =>
        f.prodR2.set(
          `runs/${RUN}/steps/dedupe.json`,
          JSON.stringify({
            output: { items: [{ ...passed[0], content_key: `runs/${RUN}/steps/fetch.json` }] },
          }),
        ),
      RUN,
      /content key/,
    ],
    [
      "an Item with no row in production",
      (f: Fake) => f.prodDb.exec("DELETE FROM items WHERE source_id = 'vllm-blog'"),
      RUN,
      /no row in production/,
    ],
    [
      "a missing content object",
      (f: Fake) => f.prodR2.delete(ITEMS[0]?.content_key as string),
      RUN,
      /key does not exist/,
    ],
  ])("refuses %s and writes nothing locally", async (_label, arrange, runId, message) => {
    const f = fake();
    arrange(f);

    await expect(copy(f, "synthesis", runId)).rejects.toThrow(message);

    expect(f.calls.some((c) => c.includes("--local"))).toBe(false);
    expect(count(f.localDb, "runs")).toBe(0);
  });

  it("reports a local D1 write that fails", async () => {
    const f = fake();
    f.localDb.exec("ALTER TABLE items DROP COLUMN published_at");

    await expect(copy(f)).rejects.toThrow(/local D1.*npm run dev/s);
  });
});

describe("stagesBefore", () => {
  it("lists every stage before the starting stage", () => {
    expect(stagesBefore("triage")).toEqual(["fetch", "dedupe"]);
    expect(stagesBefore("synthesis")).toEqual(["fetch", "dedupe", "triage"]);
  });
});

describe("isItemContentKey", () => {
  it("accepts keys as dedupe writes them", () => {
    expect(isItemContentKey(contentKey("vllm-blog", "https://vllm.ai/blog/a?x=1#y", RUN))).toBe(
      true,
    );
  });

  it.each([
    ["another prefix", "runs/r1/steps/fetch.json"],
    ["a dot-dot segment", "items/a/../../runs/r1.md"],
    ["a dot segment", "items/./a/r1.md"],
    ["an empty segment", "items//a/r1.md"],
    ["a trailing slash", "items/a/b/r1.md/"],
    ["a backslash", "items/a/..\\..\\b/r1.md"],
    ["an extra segment", "items/a/b/c/r1.md"],
    ["a Run segment that is not a Run ID", "items/a/b/r.1.md"],
    ["a query", "items/a/b/r1.md?versionId=1"],
    ["a fragment", "items/a/b#/r1.md"],
    ["whitespace", "items/a b/c/r1.md"],
    ["a control character", "items/a\u0000b/c/r1.md"],
    ["no .md ending", "items/a/b/r1.json"],
    ["a non-string", 7],
  ])("rejects %s", (_label, key) => {
    expect(isItemContentKey(key)).toBe(false);
  });
});

describe("checkCommand", () => {
  const select = "SELECT * FROM runs WHERE id = 'r1'";
  const d1 = (...rest: string[]) => ["d1", "execute", "research-lackey", ...rest];

  it.each([
    ["a production SELECT", d1("--remote", "--json", "--command", select)],
    [
      "a production R2 get",
      ["r2", "object", "get", "research-lackey/k", "--remote", "--file", "f"],
    ],
    ["a local D1 file", d1("--local", "--file", "copy.sql")],
    ["a local R2 put", ["r2", "object", "put", "research-lackey/k", "--local", "--file", "f"]],
  ])("allows %s", (_label, argv) => {
    expect(() => checkCommand(argv)).not.toThrow();
  });

  it.each([
    [
      "a production INSERT",
      d1("--remote", "--json", "--command", "INSERT INTO runs (id) VALUES ('x')"),
    ],
    [
      "a production SELECT followed by a DELETE",
      d1("--remote", "--json", "--command", `${select}; DELETE FROM runs`),
    ],
    ["a production SQL file", d1("--remote", "--file", "copy.sql")],
    [
      "a production SELECT with an extra flag",
      d1("--remote", "--json", "--command", select, "--file", "x.sql"),
    ],
    [
      "a production R2 put",
      ["r2", "object", "put", "research-lackey/k", "--remote", "--file", "f"],
    ],
    ["a production R2 delete", ["r2", "object", "delete", "research-lackey/k", "--remote"]],
    ["a production migration", ["d1", "migrations", "apply", "research-lackey", "--remote"]],
    ["a command with neither --local nor --remote", d1("--file", "copy.sql")],
    ["a command with both", d1("--local", "--remote", "--json", "--command", select)],
  ])("refuses %s", (_label, argv) => {
    expect(() => checkCommand(argv)).toThrow();
  });
});
