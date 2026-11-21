import type { FetchConfig } from "../core/config";
import { parseFeed } from "../core/feeds";
import type { FeedRead, FeedRequest, SourceFetcher } from "../core/ports";

/** Names the project and its public site. No personal contact details. */
export const USER_AGENT = "research-lackey/1.0 (+https://lackey.jsulz.com)";

const ACCEPT =
  "application/atom+xml, application/rss+xml, application/xml;q=0.9, application/json;q=0.9, */*;q=0.5";

/** Longest network error text kept in a failure reason. */
const MAX_ERROR_TEXT = 200;

/** The outbound request as the fetcher makes it. */
export interface OutboundInit {
  headers: Record<string, string>;
  signal: AbortSignal;
  redirect: "follow";
}

export interface HttpSourceFetcherDeps {
  /** The outbound fetch. Production passes the global `fetch`. */
  fetch(url: string, init: OutboundInit): Promise<Response>;
  /** Waits between retries and between requests to one host. */
  sleep(ms: number): Promise<void>;
  /** Milliseconds since the epoch. */
  now(): number;
  settings: FetchConfig;
}

/** One request's result: a body to parse, a failure worth another request, or a final failure. */
type Attempt =
  | { kind: "body"; text: string }
  | { kind: "retry"; reason: string }
  | { kind: "final"; reason: string };

/**
 * SourceFetcher over HTTP. A timeout, a network error, a 429 or a 5xx is retried
 * `settings.retries` times, waiting `backoff_ms`, then twice that, and so on. Any other status
 * that is not 2xx fails at once, and so does a body that does not parse as the Source's format.
 * Requests to a host listed in `host_intervals_ms` start at least that long after the previous
 * request to it ended, retries included. One instance serves one Run, whose Sources are read one
 * at a time.
 */
export class HttpSourceFetcher implements SourceFetcher {
  private readonly lastRequestEnd = new Map<string, number>();

  constructor(private readonly deps: HttpSourceFetcherDeps) {}

  async fetch(request: FeedRequest): Promise<FeedRead> {
    const { settings, sleep, now } = this.deps;
    let host: string;
    try {
      host = new URL(request.url).hostname;
    } catch {
      return { ok: false, reason: "Source URL does not parse", attempts: 0 };
    }
    let attempts = 0;
    let reason = "";
    for (let retry = 0; retry <= settings.retries; retry++) {
      if (retry > 0) await sleep(settings.backoff_ms * 2 ** (retry - 1));
      await this.waitForHost(host);
      attempts++;
      const attempt = await this.request(request.url);
      this.lastRequestEnd.set(host, now());
      if (attempt.kind === "body") {
        try {
          return { ok: true, items: parseFeed(request.format, attempt.text), attempts };
        } catch (err) {
          return { ok: false, reason: errorText(err), attempts };
        }
      }
      reason = attempt.reason;
      if (attempt.kind === "final") break;
    }
    return {
      ok: false,
      reason: attempts > 1 ? `${reason} (${attempts} attempts)` : reason,
      attempts,
    };
  }

  /** Waits until the host's interval has passed since the last request to it ended. */
  private async waitForHost(host: string): Promise<void> {
    const { settings, sleep, now } = this.deps;
    const interval = Object.hasOwn(settings.host_intervals_ms, host)
      ? settings.host_intervals_ms[host]
      : undefined;
    const last = this.lastRequestEnd.get(host);
    if (!interval || last === undefined) return;
    // A timer may fire a moment early: check again, a bounded number of times.
    for (let i = 0; i < 3; i++) {
      const wait = last + interval - now();
      if (wait <= 0) return;
      await sleep(wait);
    }
  }

  /** One GET, bounded by the timeout from the first byte sent to the last byte read. */
  private async request(url: string): Promise<Attempt> {
    const { timeout_ms } = this.deps.settings;
    const controller = new AbortController();
    const timeout: Attempt = { kind: "retry", reason: `Timed out after ${timeout_ms} ms` };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The abort ends a request the runtime can cancel; the race bounds one it can't.
    const timedOut = new Promise<Attempt>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(timeout);
      }, timeout_ms);
    });
    const read = async (): Promise<Attempt> => {
      const response = await this.deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: ACCEPT },
        signal: controller.signal,
        redirect: "follow",
      });
      if (response.ok) return { kind: "body", text: await response.text() };
      await response.body?.cancel().catch(() => {});
      const transient = response.status === 429 || response.status >= 500;
      return { kind: transient ? "retry" : "final", reason: `HTTP ${response.status}` };
    };
    try {
      return await Promise.race([read(), timedOut]);
    } catch (err) {
      if (controller.signal.aborted) return timeout;
      return { kind: "retry", reason: `Network error: ${errorText(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorText(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)) || "unknown error";
  return text.length <= MAX_ERROR_TEXT ? text : `${text.slice(0, MAX_ERROR_TEXT - 1)}…`;
}
