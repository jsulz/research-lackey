import { describe, expect, it } from "vitest";
import { canonicalJson, runConfigRecord, sha256Hex } from "../../src/core/hashing";

// SHA-256 test vectors from FIPS 180-2.
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sha256Hex", () => {
  it("matches the standard test vectors", async () => {
    expect(await sha256Hex("abc")).toBe(SHA_ABC);
    expect(await sha256Hex("")).toBe(SHA_EMPTY);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("runConfigRecord", () => {
  it("snapshots the config as canonical JSON, hashes it, and hashes each prompt file", async () => {
    const record = await runConfigRecord({ b: 2, a: 1 }, { synthesis: "abc", triage: "" });
    expect(record.config_snapshot).toBe('{"a":1,"b":2}');
    expect(record.config_hash).toBe(await sha256Hex('{"a":1,"b":2}'));
    expect(record.prompt_hashes).toEqual({ synthesis: SHA_ABC, triage: SHA_EMPTY });
  });

  it("gives the same config hash whatever the key order", async () => {
    const one = await runConfigRecord({ a: 1, b: { c: 2, d: 3 } }, {});
    const two = await runConfigRecord({ b: { d: 3, c: 2 }, a: 1 }, {});
    expect(one.config_hash).toBe(two.config_hash);
  });
});
