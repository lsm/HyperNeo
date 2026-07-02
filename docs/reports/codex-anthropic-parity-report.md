# Codex Anthropic Parity Report

> **Note:** This report has been superseded by `docs/reports/provider-parity-final-report.md`.

**Date:** 2026-03-16  
**Repo:** `/Users/lsm/focus/dev-neokai`  
**Scope:** `packages/daemon/src/lib/providers/anthropic-to-codex-bridge-provider.ts` + `packages/daemon/src/lib/providers/codex-anthropic-bridge/*`

## Executive Summary

**Verdict: Partial parity (not full Anthropic API parity).**

The Codex bridge is solid for HyperNeo’s current path (streaming + single tool round-trip), but it is not a full Anthropic-compatible implementation.

---

## 1) Endpoint parity

| Anthropic surface | Status | Notes |
|---|---|---|
| `POST /v1/messages` | ✅ | Implemented in bridge server |
| `GET /health`, `GET /v1/health` | ➕ | Convenience endpoints (non-Anthropic extras) |
| Other Anthropic endpoints (e.g. `/v1/messages/count_tokens`, `/v1/models`) | ❌ | Not implemented |

---

## 2) Request contract parity (`/v1/messages`)

| Field/behavior | Status | Notes |
|---|---|---|
| `model` | ✅ | Used |
| `messages` | ✅ | Used |
| `system` | ✅ Partial | Extracted as plain text |
| `tools` | ✅ | Mapped to Codex dynamic tools |
| `max_tokens` | ⚠️ Partial | Accepted but not strictly enforced end-to-end |
| `stream=true` | ✅ | SSE path works |
| `stream=false` | ❌ | Still returns SSE; no Anthropic JSON non-stream response path |
| `tool_choice` | ❌ | Not supported |
| `temperature` / `top_p` / `top_k` | ❌ | Not supported |
| `stop_sequences` | ❌ | Not supported |
| `metadata` / thinking fields | ❌ | Not supported |
| multimodal input (images/documents) | ❌ | Not supported |

---

## 3) Response/SSE parity

| Behavior | Status | Notes |
|---|---|---|
| Anthropic-like SSE events | ✅ | `message_start`, `content_block_*`, `message_delta`, `message_stop` |
| `tool_use` stop path | ✅ | Emits `tool_use`, suspends, resumes on `tool_result` |
| Single tool continuation | ✅ | Works |
| Multiple tool results in one continuation | ❌ | Server uses only first tool result (`toolResults[0]`) |
| Full structured Anthropic message semantics | ❌ | Conversation is flattened to text |
| Usage/token parity | ❌ | Input tokens are synthetic/0; output is estimated heuristic |
| Anthropic JSON error envelope parity | ❌ | Plain-text HTTP errors and text-in-band `[Codex error: ...]` |

---

## 4) Tool-use parity

| Capability | Status | Notes |
|---|---|---|
| Single tool call round-trip | ✅ | Implemented and tested |
| MCP-style tool names (`mcp__...`) | ✅ | Name translation + reverse mapping present |
| Collision detection for translated names | ✅ | Fail-fast implemented |
| Parallel/multi-tool blocks in one assistant turn | ❌ | Not modeled as Anthropic multi-tool response; flow is one call at a time |
| `tool_choice` control parity | ❌ | Missing |

---

## 5) Provider capability flags

| Capability | `anthropic` | `anthropic-codex` |
|---|---:|---:|
| streaming | ✅ | ✅ |
| function calling | ✅ | ✅ |
| vision | ✅ | ❌ |
| extended thinking | ✅ | ❌ |

---

## 6) Validation run

Executed unit tests:

```bash
bun test \
  packages/daemon/tests/unit/providers/anthropic-to-codex-bridge-provider.test.ts \
  packages/daemon/tests/unit/providers/codex-anthropic-bridge/server.test.ts \
  packages/daemon/tests/unit/providers/codex-anthropic-bridge/process-manager.test.ts \
  packages/daemon/tests/unit/providers/codex-anthropic-bridge/translator.test.ts
```

Result:

- **75 passed, 0 failed**

These validate:

- Credential discovery/auth wiring
- SSE streaming shape
- Tool-use suspend/resume
- TTL cleanup of suspended sessions
- MCP-style tool name translation

---

## Final assessment

### What is good now

- Reliable Anthropic-shaped streaming for Codex backend.
- Single tool-use round-trip works and is tested.
- Practical for HyperNeo’s current SDK flow.

### What blocks “full Anthropic parity”

- No non-stream (`stream=false`) response mode.
- Missing key request fields (`tool_choice`, sampling, stop sequences, etc.).
- Text-flattened conversation semantics instead of full block-structured Anthropic semantics.
- Incomplete multi-tool/multi-result parity.
- Non-parity usage accounting and error envelope behavior.

### Bottom line

This is **Anthropic-compatible for HyperNeo’s narrow Codex bridge workflow**, not a **full Anthropic API drop-in**.
