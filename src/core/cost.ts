import type { ModelPrice } from "./config";
import type { ModelUsage } from "./ports";

/**
 * The USD cost of one model call: Anthropic's reported usage times the price table (ADR-0004).
 * The prompt length that selects a long-context tier counts input plus cache reads and writes.
 */
export function stageCost(usage: ModelUsage, price: ModelPrice): number {
  const prompt =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_write_5m_input_tokens +
    usage.cache_write_1h_input_tokens;
  const long = price.long_context;
  const tier = long && prompt > long.above_prompt_tokens ? long.tier : price.standard;
  return (
    (usage.input_tokens * tier.input +
      usage.output_tokens * tier.output +
      usage.cache_read_input_tokens * tier.cache_read +
      usage.cache_write_5m_input_tokens * tier.cache_write_5m +
      usage.cache_write_1h_input_tokens * tier.cache_write_1h) /
    1_000_000
  );
}
