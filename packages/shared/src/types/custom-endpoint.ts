/**
 * Custom Endpoint types
 *
 * User-configurable API endpoints. Each endpoint advertises a `type` that
 * selects the upstream API surface and the bridge that translates between it
 * and the Anthropic Messages API the SDK speaks:
 *
 *   - `openai-chat`         OpenAI Chat Completions (LM Studio, vLLM, LiteLLM,
 *                           Ollama OpenAI shim, OpenRouter-compatible proxies)
 *   - `anthropic-messages`  Anthropic Messages API pass-through (Bedrock fronts,
 *                           self-hosted Anthropic-shim, custom Claude gateways)
 *   - `ollama-native`       Ollama native API (`/api/chat`, `/api/tags`) for
 *                           users who disable the OpenAI shim or need
 *                           Ollama-only features
 *
 * Each endpoint is registered with the provider registry at daemon startup
 * as a `CustomEndpointProvider` instance. The provider routes traffic through
 * the bridge selected by `type`.
 */

/**
 * Upstream API surface. The provider picks the appropriate bridge based on
 * this value. New types must be added to the bridge factory simultaneously.
 */
export type CustomEndpointType = 'openai-chat' | 'anthropic-messages' | 'ollama-native';

/** Default endpoint type assumed when an existing config omits `type`. */
export const DEFAULT_CUSTOM_ENDPOINT_TYPE: CustomEndpointType = 'openai-chat';

/**
 * Per-model capability hints. The provider honours these when reporting
 * `ProviderCapabilities` and when building SDK options. Features marked
 * `false` here are silently skipped instead of producing upstream errors
 * (e.g. no thinking blocks emitted, no prompt caching headers added).
 */
export interface CustomEndpointModelCapabilities {
  /** Streaming responses (SSE). Required — most endpoints support it. */
  streaming: boolean;
  /** Function/tool calling via OpenAI `tools[]` + `tool_calls`. */
  toolUse: boolean;
  /** Vision inputs (image URLs or base64 data URLs). */
  vision: boolean;
  /** Extended thinking / reasoning blocks. */
  thinking: boolean;
  /** Prompt caching support (Anthropic-style `cache_control`). */
  caching: boolean;
  /** Maximum input context window in tokens. */
  maxContextTokens: number;
  /**
   * Whether the upstream Chat Completions endpoint accepts
   * `stream_options: { include_usage: true }`. Defaults to `false` because
   * many strict OpenAI-compatible backends reject unknown request fields
   * outright (HTTP 400/422) and the field is non-essential — without it the
   * bridge falls back to a token estimator. Enable explicitly on endpoints
   * that are known-good (e.g. real OpenAI, LiteLLM, OpenRouter).
   */
  streamUsage: boolean;
  /**
   * Per-model Jinja `chat_template_kwargs` merged into every upstream
   * `/v1/chat/completions` request body. Used for fields the OpenAI Chat
   * schema does not define but llama.cpp / vLLM templates read — most
   * notably `{ enable_thinking: false }` to skip Qwen3 `<think>` blocks.
   * Omit (or leave undefined) for models that should keep default behaviour.
   */
  chatTemplateKwargs?: Record<string, unknown>;
}

/**
 * A model exposed by a custom endpoint. `id` is the user-facing label;
 * `providerModelId` is the string sent in the upstream Chat Completions
 * request body. Often they're equal (e.g. for Ollama models like
 * `qwen2.5-coder:14b`), but split lets the user surface a friendly name.
 */
export interface CustomEndpointModel {
  /** User-facing model ID. Must be unique within the endpoint. */
  id: string;
  /** Optional display name shown in pickers (defaults to `id`). */
  name?: string;
  /** The model string sent to the upstream API. Defaults to `id`. */
  providerModelId?: string;
  /** Per-model capabilities. Defaults applied by the provider. */
  capabilities?: Partial<CustomEndpointModelCapabilities>;
}

/**
 * A user-defined endpoint. Stored as JSON inside
 * `GlobalSettings.customEndpoints`. Each entry becomes its own provider in
 * the registry, with `id = "custom:" + endpoint.id`.
 */
export interface CustomEndpointConfig {
  /**
   * Unique endpoint identifier. The resulting provider ID is
   * `custom:<id>`. Should be a short slug like `lmstudio` or `litellm-prod`.
   */
  id: string;
  /**
   * Upstream API surface. Optional — existing configs persisted before this
   * field existed are treated as `openai-chat` to preserve backwards compat.
   */
  type?: CustomEndpointType;
  /** Display name shown in UIs. */
  name: string;
  /** Upstream base URL (no trailing slash needed). Required. */
  baseUrl: string;
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Extra HTTP headers attached to every upstream request. */
  headers?: Record<string, string>;
  /** Models exposed by this endpoint. At least one entry required. */
  models: CustomEndpointModel[];
  /** Default model ID (must match an entry in `models`). */
  defaultModelId?: string;
}

/** Default capabilities applied when a model omits a field. */
export const DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES: CustomEndpointModelCapabilities = {
  streaming: true,
  toolUse: true,
  vision: false,
  thinking: false,
  caching: false,
  maxContextTokens: 128000,
  // Off by default — see CustomEndpointModelCapabilities.streamUsage for why.
  streamUsage: false,
};

/**
 * Per-type capability defaults. Applied on top of the global defaults when a
 * model omits a field. `ollama-native` disables caching/thinking by default
 * because the upstream doesn't honour Anthropic-style `cache_control` headers
 * or `thinking` blocks; `anthropic-messages` defaults to the most permissive
 * profile since the request body is forwarded verbatim.
 */
export const CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS: Record<
  CustomEndpointType,
  Partial<CustomEndpointModelCapabilities>
> = {
  'openai-chat': {},
  'anthropic-messages': {
    toolUse: true,
    vision: true,
    thinking: true,
    caching: true,
  },
  'ollama-native': {
    toolUse: true,
    vision: false,
    thinking: false,
    caching: false,
  },
};

/** Resolve the effective endpoint type, defaulting when omitted. */
export function resolveCustomEndpointType(config: CustomEndpointConfig): CustomEndpointType {
  return config.type ?? DEFAULT_CUSTOM_ENDPOINT_TYPE;
}
