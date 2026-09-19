# Metadata-armed context capacity audit

Audited 2026-09-19 for #4810. `glm` and `anthropic-codex` set
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` from provider metadata. Their capacity values
therefore affect SDK compaction, not only the displayed context meter.

## OpenAI Responses API versus ChatGPT Codex OAuth

The authenticated route matters. The published API capacity is not evidence that
the ChatGPT Codex backend admits equally large inputs.

| Model | Published API window | Previous API setting | Retained OAuth setting |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol/Terra/Luna | 1,050,000 | 1,050,000 | 272,000 |
| GPT-5.5 | 1,050,000 | 272,000 | 272,000 |
| GPT-5.4 | 1,050,000 | 272,000 | 272,000 |
| GPT-5.3 Codex | 400,000 | 272,000 | 272,000 |
| GPT-5.4 Mini | 400,000 | 128,000 | 128,000 |

API sources: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5),
[GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4),
[GPT-5.3 Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex), and
[GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

The four older API entries were stale. They now use the documented API windows.
OAuth settings remain explicit overrides: [#2429](https://github.com/lsm/HyperNeo/pull/2429)
recorded real requests failing after the Codex backend reduced its input cap.
This audit does not claim to have re-probed account-specific OAuth limits.
`getModels()` now returns the same auth-dependent capacity used by the bridge
`/v1/models` response and SDK environment, avoiding a 1.05M display over a 272K
OAuth execution window. API-key credentials take precedence when both are present. `ContextFetcher`
keeps supplied route-specific metadata when the SDK reports that same model,
instead of replacing the OAuth value with an API-only static fallback. Copilot
keeps its previous provider-specific values through explicit overlay overrides;
OpenAI API documentation does not establish Copilot capacity.

## GLM

The curated static entries agree with the provider documentation:

| Models | Window | Evidence |
| --- | ---: | --- |
| GLM-5, GLM-5.1 | 200,000 | [GLM-5](https://docs.z.ai/guides/llm/glm-5), [GLM-5.1](https://docs.z.ai/guides/llm/glm-5.1) |
| GLM-5-Turbo, GLM-5V-Turbo | 200,000 | [Turbo](https://docs.z.ai/guides/llm/glm-5-turbo), [Vision Turbo](https://docs.z.ai/guides/vlm/glm-5v-turbo) |
| GLM-5.2, GLM-5.3 | 1,000,000 | [GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2), [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3) |
| GLM-5.3-Flash / FlashX | 1,000,000 | [Flash family](https://docs.z.ai/guides/vlm/glm-5.3-flash) |
| GLM-4.7 / Flash / FlashX | 200,000 | [GLM-4.7 family](https://docs.z.ai/guides/llm/glm-4.7) |

The discovered-only GLM-4.7-Flash, GLM-4.7-FlashX, and GLM-5.3-FlashX previously
fell through to the generic 128K fallback. Their documented capacities now feed
both discovery metadata and SDK compaction. Discovery still controls availability;
this does not add those models to the curated static list. Unknown IDs retain the
existing conservative fallback until their capacity is verified.

## Sourcing and reconciliation

There is no independent capacity signal in the current discovery contract:
`fetchRemoteModelList` retains model IDs/names, and the Claude Agent SDK's
`supportedModels()` has no capacity field. The local Responses bridge synthesizes
its model-list capacity and streamed usage capacity from `codex-models.ts`.
`getContextUsage()` reports the SDK's configured window; for these providers,
that window is already influenced by our environment and bridge metadata.
Blindly adopting it would validate our own assumption and could mix OAuth and
API-key limits under the same provider/model key in `model-service.ts`.

Keep capacity at the provider boundary, with auth-specific OAuth overrides and
source-backed static values where no upstream capacity API is integrated. Preserve
the existing mismatch diagnostic and native-provider reconciliation; they help
identify wiring drift, but a matching SDK window does not independently certify
upstream capacity. Future discovery must carry authenticated route identity and
validated upstream capacity before it can safely replace these values.

Regression checks cover API and OAuth catalogs, the real local bridge model-list
response, SDK environment values, aliases, GLM discovery, and the context display
and reserve-based compaction contracts. They require no paid upstream calls.
