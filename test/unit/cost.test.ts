import { describe, expect, it } from "vitest";
import { CONFIG } from "../../src/core/config";
import { stageCost } from "../../src/core/cost";
import type { ModelUsage } from "../../src/core/ports";

const NONE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_write_5m_input_tokens: 0,
  cache_write_1h_input_tokens: 0,
};

// Claude Haiku 5.5 list prices (USD per million tokens), from Anthropic's pricing page on
// 2026-11-16. Prompts up to 100,000 tokens: input 0.10, 5m write 0.125, 1h write 0.20,
// cache read 0.01, output 0.50. Over 100,000: 0.50, 0.625, 1.00, 0.05, 2.50.
describe("stageCost for claude-haiku-5-5", () => {
  const listed = CONFIG.prices["claude-haiku-5-5"];
  if (!listed) throw new Error("claude-haiku-5-5 is missing from the price table");
  const price = listed;

  it("prices input and output at the list price", () => {
    expect(stageCost({ ...NONE, input_tokens: 10_000 }, price)).toBeCloseTo(0.001, 10);
    // Output tokens don't count toward the prompt length, so a million stay standard.
    expect(stageCost({ ...NONE, output_tokens: 1_000_000 }, price)).toBeCloseTo(0.5, 10);
  });

  it("adds input, output, cache reads and both cache write durations", () => {
    // 2,000 x 0.10 + 3,000 x 0.50 + 1,000 x 0.01 + 400 x 0.125 + 100 x 0.20, per million
    // = 0.0002 + 0.0015 + 0.00001 + 0.00005 + 0.00002 = 0.00178
    const usage: ModelUsage = {
      input_tokens: 2_000,
      output_tokens: 3_000,
      cache_read_input_tokens: 1_000,
      cache_write_5m_input_tokens: 400,
      cache_write_1h_input_tokens: 100,
    };
    expect(stageCost(usage, price)).toBeCloseTo(0.00178, 10);
  });

  it("uses the long-context prices when the prompt, cache tokens included, exceeds 100,000", () => {
    // Prompt = 90,000 input + 20,000 cache read = 110,000 > 100,000.
    // 90,000 x 0.50 + 20,000 x 0.05 + 1,000 x 2.50, per million = 0.045 + 0.001 + 0.0025
    const usage = {
      ...NONE,
      input_tokens: 90_000,
      cache_read_input_tokens: 20_000,
      output_tokens: 1_000,
    };
    expect(stageCost(usage, price)).toBeCloseTo(0.0485, 10);
  });

  it("keeps the standard prices at exactly 100,000 prompt tokens", () => {
    expect(stageCost({ ...NONE, input_tokens: 100_000 }, price)).toBeCloseTo(0.01, 10);
  });
});
