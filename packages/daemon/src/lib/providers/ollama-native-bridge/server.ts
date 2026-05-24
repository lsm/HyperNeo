/**
 * Ollama Native API Bridge — Custom Endpoint Integration
 *
 * Re-exports the existing Anthropic ↔ Ollama bridge server under a stable
 * module path so the custom-endpoint provider can dispatch on
 * `type: 'ollama-native'` without coupling to the built-in `OllamaProvider`
 * file layout.
 *
 * The underlying bridge:
 *   - Translates Anthropic Messages ↔ Ollama `/api/chat`.
 *   - Streams NDJSON chunks (one JSON object per line) back as Anthropic
 *     Messages SSE events.
 *   - Maps `tool_use` blocks to Ollama 0.4+ tool calls in both directions.
 *
 * Custom-endpoint callers always bind to `127.0.0.1` so the bridge isn't
 * reachable from other local users on multi-tenant machines.
 */

export {
  createOllamaAnthropicBridgeServer as createOllamaNativeBridgeServer,
  type OllamaBridgeServer as OllamaNativeBridgeServer,
  type OllamaBridgeConfig as OllamaNativeBridgeConfig,
} from '../ollama-bridge-server.js';
