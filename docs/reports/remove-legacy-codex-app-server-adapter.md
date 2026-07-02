# Remove Legacy Codex App-Server Adapter

## Summary

The legacy Codex app-server adapter has been removed. OpenAI/Codex models now route exclusively through the newer OpenAI Responses bridge (`packages/daemon/src/lib/providers/openai-responses-bridge/`).

## Findings

### Legacy adapter surface

Independent code search found the legacy adapter under:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/token-estimator.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/model-context-windows.ts`

It was reachable from `AnthropicToCodexBridgeProvider` through the `HYPERNEO_OPENAI_BRIDGE_ADAPTER=codex` fallback path and depended on the bundled `@openai/codex` package to spawn `codex app-server` subprocesses.

### OpenAI Responses bridge coverage

The OpenAI Responses bridge already covers the required runtime behavior for OpenAI/Codex models:

- Anthropic-compatible `/v1/messages` streaming endpoint
- `/v1/models` and `/v1/messages/count_tokens` endpoints expected by the Claude Agent SDK
- Tool-use/tool-result translation via OpenAI function calls
- Per-session continuation tracking for tool calls
- ChatGPT OAuth routing to `https://chatgpt.com/backend-api/codex/responses` with `ChatGPT-Account-ID`
- Direct OpenAI API key routing to `https://api.openai.com/v1/responses`
- Reasoning/thinking support by mapping SDK thinking budgets to OpenAI `reasoning.effort`
- Model aliasing and context-window reporting for Codex model IDs

### Sessions and configuration dependency check

No session database columns require the legacy adapter. Existing sessions that use provider `anthropic-codex` continue to use the same provider ID and model IDs, but now route through the Responses bridge only.

Removed legacy configuration/runtime dependencies:

- `HYPERNEO_OPENAI_BRIDGE_ADAPTER=codex` fallback path
- `CODEX_API_KEY` runtime env-var auth path
- `@openai/codex` package dependency
- Codex binary discovery and subprocess startup
- Legacy bridge unit tests for `server.ts` and `process-manager.ts`

Preserved compatibility:

- Provider ID remains `anthropic-codex`
- Codex model IDs and aliases remain unchanged
- `OPENAI_API_KEY` direct auth remains supported
- HyperNeo OpenAI OAuth remains supported
- One-time import from `~/.codex/auth.json` remains supported so existing Codex-login users can migrate credentials into `~/.hyperneo/auth.json`

## Changes Made

- Removed the legacy `codex-anthropic-bridge` server and process manager.
- Updated `AnthropicToCodexBridgeProvider` to always create the OpenAI Responses bridge.
- Moved shared Anthropic SSE/type helpers to `provider-anthropic-compat`.
- Moved Codex model metadata/context windows to `codex-models.ts`.
- Updated Ollama, Gemini, and OpenAI Responses bridge imports to use shared helper locations.
- Removed `@openai/codex` from daemon dependencies and knip ignore rules.
- Removed legacy adapter unit tests and updated provider/query-option tests.
- Updated provider setup documentation and real-API workflow comments.

## Validation

Commands run:

```bash
cd packages/daemon && bun test --preload=./tests/unit/setup.ts \
  tests/unit/1-core/providers/anthropic-to-codex-bridge-provider.test.ts \
  tests/unit/1-core/providers/openai-responses-bridge/server.test.ts \
  tests/unit/1-core/providers/gemini-format-converter.test.ts \
  tests/unit/1-core/agent/query-options-builder.test.ts

bun run typecheck
bun run lint
bun run knip
```

Results:

- Affected daemon unit tests: 261 pass, 0 fail
- Typecheck: pass
- Lint: pass
- Knip: pass

## Conclusion

The legacy Codex app-server adapter and its subprocess dependency have been removed. OpenAI/Codex sessions now use the Responses bridge exclusively, while preserving the existing `anthropic-codex` provider identity, model catalog, OpenAI API key auth, OAuth auth, and legacy credential import path.
