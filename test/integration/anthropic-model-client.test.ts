import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "../../src/adapters/anthropic-model-client";

// The adapter's request and parsing rules are unit-tested in Node. This proves the Anthropic SDK
// bundles and runs in the Workers runtime, with no network: fetch is replaced.
describe("AnthropicModelClient in the Workers runtime", () => {
  it("makes a call through the injected fetch and parses usage", async () => {
    const urls: string[] = [];
    const client = new AnthropicModelClient({
      gateway: { accountId: "acct", gatewayId: "gw", token: "t" },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      fetch: async (input, init) => {
        urls.push(new Request(input, init).url);
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: '{"ok":true}' }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    });
    const res = await client.call({
      task: "synthesis",
      model: "claude-haiku-5-5",
      system: "s",
      prompt: "p",
      effort: "medium",
      max_tokens: 100,
      json_schema: { type: "object" },
      metadata: { run_id: "r", topic_id: "t", step: "synthesis", env: "dev" },
    });
    expect(urls).toEqual(["https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages"]);
    expect(res.json).toEqual({ ok: true });
    expect(res.usage.input_tokens).toBe(10);
  });
});
