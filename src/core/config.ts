import type { Effort, TaskName } from "./ports";

/** USD per million tokens. */
export interface PriceTier {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

/**
 * A model's prices. Some models charge more for long prompts: `long_context` applies when the
 * prompt (input plus cache reads and writes) exceeds `above_prompt_tokens`.
 */
export interface ModelPrice {
  standard: PriceTier;
  long_context?: { above_prompt_tokens: number; tier: PriceTier };
}

/** The model and request settings for one task. */
export interface TaskConfig {
  model: string;
  effort: Effort;
  max_tokens: number;
}

/** How feeds are requested. */
export interface FetchConfig {
  /** Longest one request may take, headers and body, before it counts as timed out. */
  timeout_ms: number;
  /** Extra requests after a timeout, a network error, a 429 or a 5xx. Other statuses are final. */
  retries: number;
  /** Wait before the first retry; each later retry waits twice as long as the one before. */
  backoff_ms: number;
  /** Shortest gap between requests to a host, by host name. Hosts not listed have none. */
  host_intervals_ms: Record<string, number>;
}

/**
 * Typed Run configuration. Values are tuning starting points (T1 spec, "Behavioral rules").
 * Each Run stores a snapshot of it and its hash.
 */
export interface RunConfig {
  /** On a Source's first poll, every Item is recorded but only the newest this many pass onward. */
  first_poll_cap: number;
  /** How many new Items Triage scores per Run, newest first. Items over the limit are recorded but not read. */
  triage_limit: number;
  /** For an Item with no summary, how many characters of its content, as text, Triage reads. */
  triage_content_chars: number;
  /** How many Items, highest Triage score first, Synthesis reads. */
  synthesis_k: number;
  /** How many characters of each Item's content, as text, Synthesis reads. Content is preferred to the summary. */
  synthesis_content_chars: number;
  /**
   * Longest summary, in characters, sent to a model per Item: by Triage, and by Synthesis for an
   * Item whose content has no text.
   */
  item_text_cap: number;
  /** At most this many Item content writes to R2 run at once in `dedupe`. Matters on first polls. */
  content_write_concurrency: number;
  /** Timeout, retries and per-host spacing for feed requests. */
  fetch: FetchConfig;
  /** Which model runs each task. */
  tasks: Record<TaskName, TaskConfig>;
  /** Price table per model ID. Update it when Anthropic changes prices (ADR-0004). */
  prices: Record<string, ModelPrice>;
}

export const CONFIG: RunConfig = {
  first_poll_cap: 10,
  triage_limit: 100,
  triage_content_chars: 3_000,
  synthesis_k: 8,
  synthesis_content_chars: 16_000,
  item_text_cap: 4_000,
  content_write_concurrency: 8,
  fetch: {
    timeout_ms: 20_000,
    retries: 2,
    backoff_ms: 1_000,
    // arXiv's terms of use: at most one request every 3 seconds.
    host_intervals_ms: { "export.arxiv.org": 3_000 },
  },
  tasks: {
    // Scoring is classification: low effort keeps thinking tokens down.
    triage: { model: "claude-haiku-5-5", effort: "low", max_tokens: 8_000 },
    // Synthesis is where a stronger model earns its cost. High effort is the quality-first start;
    // max_tokens covers its thinking plus the Report, so the Report isn't cut off.
    synthesis: { model: "claude-sonnet-5-5", effort: "high", max_tokens: 32_000 },
  },
  prices: {
    // Anthropic list prices, checked 2026-11-16.
    "claude-haiku-5-5": {
      standard: {
        input: 0.1,
        output: 0.5,
        cache_read: 0.01,
        cache_write_5m: 0.125,
        cache_write_1h: 0.2,
      },
      long_context: {
        above_prompt_tokens: 100_000,
        tier: {
          input: 0.5,
          output: 2.5,
          cache_read: 0.05,
          cache_write_5m: 0.625,
          cache_write_1h: 1,
        },
      },
    },
    // Anthropic list prices, checked 2026-11-21. Cache reads are 0.05x input. The full context
    // window bills at standard rates: no long-context tier.
    "claude-sonnet-5-5": {
      standard: {
        input: 2,
        output: 10,
        cache_read: 0.1,
        cache_write_5m: 2.5,
        cache_write_1h: 4,
      },
    },
  },
};
