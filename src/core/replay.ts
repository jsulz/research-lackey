import { CONFIG, type ModelPrice, type PriceTier, type RunConfig, type TaskConfig } from "./config";
import type { Effort, ReplayStage, StepName, TaskName } from "./ports";

// Replays rerun a Run from `triage` or `synthesis` with an alternate config. Only runtime-free
// imports here: Node scripts (`npm run replay`) load this file with type stripping.

export const REPLAY_STAGES: readonly ReplayStage[] = ["triage", "synthesis"];

export function isReplayStage(value: unknown): value is ReplayStage {
  return REPLAY_STAGES.includes(value as ReplayStage);
}

/** The stage whose Step artifact output a Replay from `from` reuses as its first input. */
export function priorStage(from: ReplayStage): StepName {
  return from === "triage" ? "dedupe" : "triage";
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const TASKS: readonly TaskName[] = ["triage", "synthesis"];
const LIMITS = [
  "first_poll_cap",
  "triage_limit",
  "triage_content_chars",
  "synthesis_k",
  "synthesis_content_chars",
  "item_text_cap",
] as const;
const TIER_FIELDS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"] as const;
/**
 * Highest accepted price, USD per million tokens: far above any Claude price, and low enough that
 * a stage's cost (tokens times price) stays finite.
 */
const MAX_PRICE = 10_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function task(v: unknown, name: string): Parsed<TaskConfig> {
  if (!isObject(v)) return { ok: false, reason: `tasks.${name} must be an object` };
  if (typeof v.model !== "string" || v.model === "") {
    return { ok: false, reason: `tasks.${name}.model must be a model ID` };
  }
  if (!EFFORTS.includes(v.effort as Effort)) {
    return { ok: false, reason: `tasks.${name}.effort must be one of ${EFFORTS.join(", ")}` };
  }
  if (!isPositiveInt(v.max_tokens)) {
    return { ok: false, reason: `tasks.${name}.max_tokens must be a positive integer` };
  }
  return {
    ok: true,
    value: { model: v.model, effort: v.effort as Effort, max_tokens: v.max_tokens },
  };
}

function tier(v: unknown, path: string): Parsed<PriceTier> {
  if (!isObject(v)) return { ok: false, reason: `${path} must be an object` };
  const out: Partial<PriceTier> = {};
  for (const f of TIER_FIELDS) {
    const n = v[f];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
      return { ok: false, reason: `${path}.${f} must be a number from 0 to ${MAX_PRICE}` };
    }
    out[f] = n;
  }
  return { ok: true, value: out as PriceTier };
}

function price(v: unknown, model: string): Parsed<ModelPrice> {
  const path = `prices["${model}"]`;
  if (!isObject(v)) return { ok: false, reason: `${path} must be an object` };
  const standard = tier(v.standard, `${path}.standard`);
  if (!standard.ok) return standard;
  if (v.long_context === undefined) return { ok: true, value: { standard: standard.value } };
  const lc = v.long_context;
  if (!isObject(lc) || !isPositiveInt(lc.above_prompt_tokens)) {
    return {
      ok: false,
      reason: `${path}.long_context.above_prompt_tokens must be a positive integer`,
    };
  }
  const lcTier = tier(lc.tier, `${path}.long_context.tier`);
  if (!lcTier.ok) return lcTier;
  return {
    ok: true,
    value: {
      standard: standard.value,
      long_context: { above_prompt_tokens: lc.above_prompt_tokens, tier: lcTier.value },
    },
  };
}

/**
 * Checks an alternate config against `RunConfig` and returns it with only the known fields, so a
 * Replay's snapshot is exactly the config it ran with. Every task's model needs a price.
 */
export function parseRunConfig(
  value: unknown,
): { ok: true; config: RunConfig } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: "config must be an object" };
  const limits: Partial<Record<(typeof LIMITS)[number], number>> = {};
  for (const name of LIMITS) {
    const v = value[name];
    if (!isPositiveInt(v)) return { ok: false, reason: `${name} must be a positive integer` };
    limits[name] = v;
  }
  // Optional: Replay config files written before JSU-36 leave it out, and Replays never run dedupe.
  const content_write_concurrency =
    value.content_write_concurrency ?? CONFIG.content_write_concurrency;
  if (!isPositiveInt(content_write_concurrency)) {
    return { ok: false, reason: "content_write_concurrency must be a positive integer" };
  }
  if (!isObject(value.tasks)) return { ok: false, reason: "tasks must be an object" };
  const tasks: Partial<Record<TaskName, TaskConfig>> = {};
  for (const name of TASKS) {
    const t = task(value.tasks[name], name);
    if (!t.ok) return t;
    tasks[name] = t.value;
  }
  if (!isObject(value.prices)) return { ok: false, reason: "prices must be an object" };
  const prices: Record<string, ModelPrice> = {};
  for (const [model, v] of Object.entries(value.prices)) {
    const p = price(v, model);
    if (!p.ok) return p;
    prices[model] = p.value;
  }
  for (const name of TASKS) {
    const model = tasks[name]?.model ?? "";
    if (!Object.hasOwn(prices, model)) {
      return { ok: false, reason: `tasks.${name}.model ${model} has no entry in prices` };
    }
  }
  return {
    ok: true,
    config: {
      ...(limits as Record<(typeof LIMITS)[number], number>),
      content_write_concurrency,
      tasks: tasks as Record<TaskName, TaskConfig>,
      prices,
    },
  };
}
