import { describe, expect, it } from "vitest";
import {
  HttpSourceFetcher,
  type OutboundInit,
  USER_AGENT,
} from "../../src/adapters/http-source-fetcher";
import type { FetchConfig } from "../../src/core/config";
import type { FeedRequest } from "../../src/core/ports";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><guid>g1</guid><link>https://example.com/1</link><title>One</title></item>
</channel></rss>`;

const SETTINGS: FetchConfig = {
  timeout_ms: 1_000,
  retries: 2,
  backoff_ms: 100,
  host_intervals_ms: {},
};

type Step = number | "ok" | "network" | "hang" | "stalled-body" | "stalled-404" | { body: string };

/** A fetcher over a scripted outbound fetch and a virtual clock that only `sleep` advances. */
function harness(steps: Step[], settings: Partial<FetchConfig> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const requests: { url: string; init: OutboundInit; at: number }[] = [];
  const queue = [...steps];
  const fetcher = new HttpSourceFetcher({
    settings: { ...SETTINGS, ...settings },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch: async (url, init) => {
      requests.push({ url, init, at: clock });
      const step = queue.shift() ?? "ok";
      if (step === "network") throw new TypeError("connection reset");
      if (step === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      // Headers arrive, then the body never does, and neither reading nor cancelling it settles.
      if (step === "stalled-body" || step === "stalled-404") {
        const never = new Promise<never>(() => {});
        return {
          ok: step === "stalled-body",
          status: step === "stalled-body" ? 200 : 404,
          text: () => never,
          body: { cancel: () => never },
        } as unknown as Response;
      }
      if (typeof step === "number") return new Response("nope", { status: step });
      return new Response(step === "ok" ? FEED : step.body, { status: 200 });
    },
  });
  return { fetcher, sleeps, requests };
}

function request(url = "https://example.com/feed.xml"): FeedRequest {
  return { source_id: "s", url, format: "rss2" };
}

describe("HttpSourceFetcher", () => {
  it("reads a feed in one request, sending the project User-Agent", async () => {
    const h = harness(["ok"]);

    const read = await h.fetcher.fetch(request());

    expect(read).toMatchObject({ ok: true, attempts: 1 });
    expect(read.ok && read.items.map((i) => i.title)).toEqual(["One"]);
    expect(h.requests.map((r) => r.url)).toEqual(["https://example.com/feed.xml"]);
    expect(h.requests[0]?.init.headers["User-Agent"]).toBe(USER_AGENT);
    expect(h.requests[0]?.init.redirect).toBe("follow");
    expect(h.sleeps).toEqual([]);
  });

  it("names the project in the User-Agent and carries no contact details", () => {
    expect(USER_AGENT).toMatch(/^research-lackey\/\d/);
    expect(USER_AGENT).not.toMatch(/@|mailto/i);
  });

  it.each([
    ["a 429", 429],
    ["a 500", 500],
    ["a 503", 503],
    ["a network error", "network"],
  ] as const)("retries %s, then reads the feed", async (_name, step) => {
    const h = harness([step, "ok"]);

    expect(await h.fetcher.fetch(request())).toMatchObject({ ok: true, attempts: 2 });
    expect(h.sleeps).toEqual([100]);
  });

  it("retries twice with a doubling wait, then fails with the last reason and 3 attempts", async () => {
    const h = harness([503, 429, 502, "ok"]);

    expect(await h.fetcher.fetch(request())).toEqual({
      ok: false,
      reason: "HTTP 502 (3 attempts)",
      attempts: 3,
    });
    expect(h.sleeps).toEqual([100, 200]);
    expect(h.requests).toHaveLength(3);
  });

  it.each([400, 401, 403, 404, 410])("fails at once on a %i", async (status) => {
    const h = harness([status, "ok"]);

    expect(await h.fetcher.fetch(request())).toEqual({
      ok: false,
      reason: `HTTP ${status}`,
      attempts: 1,
    });
    expect(h.requests).toHaveLength(1);
  });

  it("makes no retry when retries is 0", async () => {
    const h = harness([503, "ok"], { retries: 0 });

    expect(await h.fetcher.fetch(request())).toEqual({
      ok: false,
      reason: "HTTP 503",
      attempts: 1,
    });
  });

  it("times a request out, aborts it, and retries it", async () => {
    const h = harness(["hang", "ok"], { timeout_ms: 10 });

    expect(await h.fetcher.fetch(request())).toMatchObject({ ok: true, attempts: 2 });
    expect(h.requests[0]?.init.signal.aborted).toBe(true);
    expect(h.requests[1]?.init.signal.aborted).toBe(false);
  });

  it("fails after three timeouts, naming the timeout", async () => {
    const h = harness(["hang", "hang", "hang"], { timeout_ms: 10 });

    expect(await h.fetcher.fetch(request())).toEqual({
      ok: false,
      reason: "Timed out after 10 ms (3 attempts)",
      attempts: 3,
    });
  });

  it("times out a response whose body stalls after the headers, even when the abort does not end it", async () => {
    const h = harness(["stalled-body", "ok"], { timeout_ms: 10 });

    expect(await h.fetcher.fetch(request())).toMatchObject({ ok: true, attempts: 2 });
    expect(h.requests[0]?.init.signal.aborted).toBe(true);
  });

  it("fails at once on a 404 whose body cannot be discarded, without waiting for the timeout", async () => {
    const h = harness(["stalled-404", "ok"], { timeout_ms: 50 });

    expect(await h.fetcher.fetch(request())).toEqual({
      ok: false,
      reason: "HTTP 404",
      attempts: 1,
    });
    expect(h.requests).toHaveLength(1);
  });

  it("names a network error in the reason", async () => {
    const h = harness(["network", "network", "network"]);

    expect(await h.fetcher.fetch(request())).toEqual({
      ok: false,
      reason: "Network error: connection reset (3 attempts)",
      attempts: 3,
    });
  });

  it("fails without a retry when the body is not the Source's format", async () => {
    const h = harness([{ body: "<html><body>Just a moment...</body></html>" }, "ok"]);

    const read = await h.fetcher.fetch(request());

    expect(read).toMatchObject({ ok: false, attempts: 1 });
    expect(h.requests).toHaveLength(1);
  });

  it("reads an empty feed as zero entries", async () => {
    const h = harness([{ body: "[]" }]);

    expect(await h.fetcher.fetch({ ...request(), format: "hf_daily_papers" })).toEqual({
      ok: true,
      items: [],
      attempts: 1,
    });
  });

  describe("host spacing", () => {
    const spaced = { host_intervals_ms: { "export.arxiv.org": 3_000 } };

    it("starts a request to a listed host only after its interval since the last one", async () => {
      const h = harness(["ok", "ok", "ok"], spaced);

      await h.fetcher.fetch(request("https://export.arxiv.org/api/query?a"));
      await h.fetcher.fetch(request("https://example.com/feed.xml"));
      await h.fetcher.fetch(request("https://EXPORT.arxiv.org/api/query?b"));

      expect(h.sleeps).toEqual([3_000]);
      expect(h.requests.map((r) => r.at)).toEqual([0, 0, 3_000]);
    });

    it("waits only for what is left of the interval", async () => {
      const h = harness(["ok", 503, "ok", "ok"], { ...spaced, backoff_ms: 1_000 });

      await h.fetcher.fetch(request("https://export.arxiv.org/api/query?a"));
      // Another host's retry wait (1,000 ms) passes in between.
      await h.fetcher.fetch(request("https://example.com/feed.xml"));
      await h.fetcher.fetch(request("https://export.arxiv.org/api/query?b"));

      expect(h.sleeps).toEqual([1_000, 2_000]);
    });

    it("keeps retries to a listed host the interval apart, when it is longer than the backoff", async () => {
      const h = harness([503, 503, "ok"], spaced);

      expect(await h.fetcher.fetch(request("https://export.arxiv.org/api/query?a"))).toMatchObject({
        ok: true,
        attempts: 3,
      });
      // Backoff 100 then 2,900 more; backoff 200 then 2,800 more.
      expect(h.sleeps).toEqual([100, 2_900, 200, 2_800]);
      expect(h.requests.map((r) => r.at)).toEqual([0, 3_000, 6_000]);
    });

    it("does not space hosts that are not listed", async () => {
      const h = harness(["ok", "ok"], spaced);

      await h.fetcher.fetch(request("https://arxiv.org/a"));
      await h.fetcher.fetch(request("https://arxiv.org/b"));

      expect(h.sleeps).toEqual([]);
    });
  });
});
