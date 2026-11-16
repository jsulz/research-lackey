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

/**
 * Typed Run configuration. Values are tuning starting points (T1 spec, "Behavioral rules").
 * Each Run stores a snapshot of it and its hash.
 */
export interface RunConfig {
  /** On a Source's first poll, every Item is recorded but only the newest this many pass onward. */
  first_poll_cap: number;
  /** How many new Items, newest first, Synthesis reads. Until Triage (JSU-31), all it sees. */
  synthesis_k: number;
  /** Longest text, in characters, sent to a model per Item. Keeps prompts small and cheap. */
  item_text_cap: number;
  /** Which model runs each task. T2 moves Synthesis to Sonnet by editing this table. */
  tasks: Record<TaskName, TaskConfig>;
  /** Price table per model ID. Update it when Anthropic changes prices (ADR-0004). */
  prices: Record<string, ModelPrice>;
}

export const CONFIG: RunConfig = {
  first_poll_cap: 10,
  synthesis_k: 5,
  item_text_cap: 4_000,
  tasks: {
    synthesis: { model: "claude-haiku-5-5", effort: "medium", max_tokens: 16_000 },
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
  },
};
