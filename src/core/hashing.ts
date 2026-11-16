import type { RunConfigRecord } from "./ports";

/** Lowercase hex SHA-256 of the UTF-8 text. Uses Web Crypto, available in Workers and Node. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every depth, so equal values always serialize the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Snapshots the config and hashes it and every prompt. Computed per Run: no manual rehash. */
export async function runConfigRecord(
  config: unknown,
  prompts: Record<string, string>,
): Promise<RunConfigRecord> {
  const config_snapshot = canonicalJson(config);
  const prompt_hashes: Record<string, string> = {};
  for (const name of Object.keys(prompts).sort()) {
    prompt_hashes[name] = await sha256Hex(prompts[name] as string);
  }
  return { config_snapshot, config_hash: await sha256Hex(config_snapshot), prompt_hashes };
}
