import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "../../src/adapters/anthropic-model-client";
import type { ModelRequest } from "../../src/core/ports";

const TOKEN = "test-gateway-token";
const GATEWAY = { accountId: "acct123", gatewayId: "gw-test", token: TOKEN };

function recorded(name: string): string {
  return readFileSync(new URL(`../fixtures/anthropic/${name}.json`, import.meta.url), "utf8");
}

const REQUEST: ModelRequest = {
  task: "synthesis",
  model: "claude-haiku-5-5",
  system: "You write research reports.",
  prompt: "Items: ...",
  effort: "medium",
  max_tokens: 16_000,
  json_schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
  metadata: { run_id: "manual-ai-infra-x", topic_id: "ai-infra", step: "synthesis", env: "dev" },
};

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A client whose fetch records each request and answers with a recorded response body. */
function clientAnswering(body: string, logLines: string[] = []) {
  const requests: Captured[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-0001" },
    });
  };
  const log = {
    debug: (msg: string, f?: object) =>
      logLines.push(JSON.stringify({ level: "debug", msg, ...f })),
    info: (msg: string, f?: object) => logLines.push(JSON.stringify({ level: "info", msg, ...f })),
    warn: (msg: string, f?: object) => logLines.push(JSON.stringify({ level: "warn", msg, ...f })),
    error: (msg: string, f?: object) =>
      logLines.push(JSON.stringify({ level: "error", msg, ...f })),
  };
  const client = new AnthropicModelClient({ gateway: GATEWAY, log, fetch: fetchFn });
  return { client, requests };
}

describe("AnthropicModelClient request", () => {
  it("posts to the account's gateway Anthropic endpoint", async () => {
    const { client, requests } = clientAnswering(recorded("structured-with-thinking"));
    await client.call(REQUEST);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/gw-test/anthropic/v1/messages",
    );
  });

  it("uses the gateway's stored key: no x-api-key or Authorization, gateway token in cf-aig-authorization", async () => {
    const { client, requests } = clientAnswering(recorded("structured-with-thinking"));
    await client.call(REQUEST);
    const headers = requests[0]?.headers;
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("sends run_id, topic_id, step and env as cf-aig-metadata", async () => {
    const { client, requests } = clientAnswering(recorded("structured-with-thinking"));
    await client.call(REQUEST);
    expect(JSON.parse(requests[0]?.headers.get("cf-aig-metadata") ?? "null")).toEqual({
      run_id: "manual-ai-infra-x",
      topic_id: "ai-infra",
      step: "synthesis",
      env: "dev",
    });
  });

  it("sends the model, system, prompt, effort, max_tokens and the schema as structured output", async () => {
    const { client, requests } = clientAnswering(recorded("structured-with-thinking"));
    await client.call(REQUEST);
    expect(requests[0]?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 16_000,
      system: "You write research reports.",
      messages: [{ role: "user", content: "Items: ..." }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: REQUEST.json_schema },
      },
    });
  });

  it("omits the output format when no schema is given", async () => {
    const { client, requests } = clientAnswering(recorded("plain-no-cache-breakdown"));
    const { json_schema: _schema, ...plain } = REQUEST;
    await client.call(plain);
    expect(requests[0]?.body.output_config).toEqual({ effort: "medium" });
  });
});

describe("AnthropicModelClient response", () => {
  it("returns the text after any thinking block, the parsed JSON, the model and the usage", async () => {
    const { client } = clientAnswering(recorded("structured-with-thinking"));
    const res = await client.call(REQUEST);
    expect(res.model).toBe("claude-haiku-5-5");
    expect(res.json).toEqual({
      summary: "Two serving papers.",
      findings: [{ title: "Faster decoding", refs: ["I1"] }],
    });
    expect(res.text).toContain('"summary":"Two serving papers."');
    expect(res.usage).toEqual({
      input_tokens: 2481,
      output_tokens: 2967,
      cache_read_input_tokens: 320,
      cache_write_5m_input_tokens: 1200,
      cache_write_1h_input_tokens: 300,
    });
  });

  it("counts cache writes as 5-minute writes when the body has no per-duration breakdown, and null as 0", async () => {
    const { client } = clientAnswering(recorded("plain-no-cache-breakdown"));
    const { json_schema: _schema, ...plain } = REQUEST;
    const res = await client.call(plain);
    expect(res.json).toBeUndefined();
    expect(res.text).toBe("Plain answer.");
    expect(res.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_write_5m_input_tokens: 40,
      cache_write_1h_input_tokens: 0,
    });
  });

  it("leaves json undefined when the schema response text is not valid JSON", async () => {
    const body = JSON.parse(recorded("plain-no-cache-breakdown"));
    body.content = [{ type: "text", text: "not json" }];
    const { client } = clientAnswering(JSON.stringify(body));
    const res = await client.call(REQUEST);
    expect(res.json).toBeUndefined();
  });

  it("throws on a refusal, naming its category", async () => {
    const { client } = clientAnswering(recorded("refusal"));
    await expect(client.call(REQUEST)).rejects.toThrow(/refus.*cyber/i);
  });

  it("throws when the output was cut off at max_tokens", async () => {
    const { client } = clientAnswering(recorded("max-tokens"));
    await expect(client.call(REQUEST)).rejects.toThrow(/max_tokens/);
  });
});

describe("AnthropicModelClient logging", () => {
  it("logs tokens and the gateway log ID at info, and never the gateway token", async () => {
    const lines: string[] = [];
    const { client } = clientAnswering(recorded("structured-with-thinking"), lines);
    await client.call(REQUEST);
    const info = lines.map((l) => JSON.parse(l)).find((l) => l.level === "info");
    expect(info).toMatchObject({
      run_id: "manual-ai-infra-x",
      step: "synthesis",
      model: "claude-haiku-5-5",
      input_tokens: 2481,
      output_tokens: 2967,
      gateway_log_id: "log-0001",
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("logs the prompt and response truncated at debug", async () => {
    const lines: string[] = [];
    const { client } = clientAnswering(recorded("structured-with-thinking"), lines);
    await client.call({ ...REQUEST, prompt: "x".repeat(10_000) });
    const debug = lines.map((l) => JSON.parse(l)).filter((l) => l.level === "debug");
    const prompt = debug.find((l) => typeof l.prompt === "string");
    expect(prompt?.prompt.length).toBeLessThan(10_000);
    expect(debug.some((l) => typeof l.response === "string")).toBe(true);
  });
});
