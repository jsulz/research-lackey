import Anthropic from "@anthropic-ai/sdk";
import type { Logger, ModelClient, ModelRequest, ModelResponse, ModelUsage } from "../core/ports";

/** Where to reach AI Gateway. None of these values is committed: they come from Worker secrets. */
export interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  /** The gateway's authentication token, sent as `cf-aig-authorization`. Never logged. */
  token: string;
}

/** Longest prompt or response text written to a debug log line. */
const DEBUG_TEXT_LIMIT = 2_000;

/**
 * Calls Claude through AI Gateway with the Anthropic SDK (ADR-0003). The Anthropic key is stored
 * in the gateway (BYOK): the SDK gets a placeholder key and its auth headers are removed, because
 * a key in `x-api-key` bypasses the stored one.
 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly log: Logger;

  constructor(opts: { gateway: GatewayConfig; log: Logger; fetch?: typeof fetch }) {
    const { accountId, gatewayId, token } = opts.gateway;
    this.log = opts.log;
    this.client = new Anthropic({
      apiKey: "gateway-stored-key",
      baseURL: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/anthropic`,
      // The SDK sends its key as `x-api-key` and `Authorization`; the gateway must see neither.
      defaultHeaders: {
        "x-api-key": null,
        authorization: null,
        "cf-aig-authorization": `Bearer ${token}`,
      },
      // Workflow steps own retries (with backoff), so the SDK doesn't retry on its own.
      maxRetries: 0,
      timeout: 120_000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async call(req: ModelRequest): Promise<ModelResponse> {
    const { run_id, step } = req.metadata;
    this.log.debug("model request", {
      run_id,
      step,
      model: req.model,
      prompt: req.prompt.slice(0, DEBUG_TEXT_LIMIT),
    });

    const { data: message, response } = await this.client.messages
      .create(
        {
          model: req.model,
          max_tokens: req.max_tokens,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
          output_config: {
            effort: req.effort,
            ...(req.json_schema
              ? { format: { type: "json_schema" as const, schema: req.json_schema } }
              : {}),
          },
        },
        { headers: { "cf-aig-metadata": JSON.stringify(req.metadata) } },
      )
      .withResponse();

    const usage = toUsage(message.usage);
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    this.log.info("model call", {
      run_id,
      step,
      model: message.model,
      stop_reason: message.stop_reason,
      ...usage,
      gateway_log_id: response.headers.get("cf-aig-log-id"),
    });
    this.log.debug("model response", { run_id, step, response: text.slice(0, DEBUG_TEXT_LIMIT) });

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unspecified";
      throw new Error(`Model refused the request (category: ${category})`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error(`Model output was cut off at max_tokens (${req.max_tokens})`);
    }

    return {
      text,
      ...(req.json_schema ? { json: parseJson(text) } : {}),
      model: message.model,
      usage,
    };
  }
}

function toUsage(u: Anthropic.Usage): ModelUsage {
  // Older bodies report only the total cache write; count it at the 5-minute rate (the default TTL).
  const breakdown = u.cache_creation;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_5m_input_tokens: breakdown
      ? breakdown.ephemeral_5m_input_tokens
      : (u.cache_creation_input_tokens ?? 0),
    cache_write_1h_input_tokens: breakdown ? breakdown.ephemeral_1h_input_tokens : 0,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
