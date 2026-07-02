# Anthropic-Copilot Parity Report

> **Note:** This report has been superseded by `docs/reports/provider-parity-final-report.md`.

**Date:** 2026-03-16  
**Branch:** `task/investigate-using-github-copilot-cli-as-transparen`  
**Scope:** `packages/daemon/src/lib/providers/anthropic-copilot/*`

## Executive Summary

**Verdict: Partial parity.**

This branch provides strong **Claude Agent SDK workflow parity** (streaming + tool-use continuation), but it does **not** provide full Anthropic public API parity.

---

## 1) Endpoint Parity

| Anthropic API surface | Status | Notes |
|---|---|---|
| `POST /v1/messages` | ✅ Implemented | Main embedded proxy path |
| `GET /health` | ➕ Extra | Non-Anthropic convenience endpoint |
| Other Anthropic endpoints (`/v1/models`, token-count APIs, etc.) | ❌ Missing | Not implemented in this proxy |

---

## 2) Request Contract Parity (`/v1/messages`)

| Field / behavior | Status | Notes |
|---|---|---|
| `model` | ✅ | Required + used |
| `max_tokens` | ✅ | Required (validated) |
| `messages` | ✅ | Required + parsed |
| `system` | ✅ Partial | String and text blocks supported |
| `stream=true` | ✅ | Supported |
| `stream=false` | ❌ | Explicitly rejected (400) |
| `tools` | ✅ | Bridged to Copilot external tools |
| `tool_choice` | ⚠️ Accepted but ignored | Compatibility only |
| Sampling controls (`temperature`, `top_p`, `top_k`) | ❌ | Not exposed/forwarded |
| stop sequences / advanced params | ❌ | Not exposed/forwarded |
| multimodal/image content | ❌ | Not supported |
| native structured multi-turn semantics | ⚠️ Partial | Messages are flattened to prompt text |

---

## 3) Streaming / Response Parity

| SSE / response behavior | Status | Notes |
|---|---|---|
| Anthropic-style SSE framing | ✅ | Event sequence implemented |
| `tool_use` stop path | ✅ | Emits tool_use block and ends response |
| continuation via `tool_result` | ✅ | Suspended session resumes correctly |
| `end_turn` completion | ✅ | Implemented |
| token usage accounting parity | ❌ | `input_tokens` / `output_tokens` are effectively 0 (SDK limitation) |
| full Anthropic stop-reason/metadata parity | ⚠️ Partial | Narrow set in practice |

---

## 4) Tool-Use Parity

| Capability | Status | Notes |
|---|---|---|
| Single tool call | ✅ | Works |
| Parallel tool calls | ✅ | Implemented + unit tested |
| Tool error propagation (`is_error`) | ✅ | Mapped to failure |
| Follow-up without re-sending `tools` | ✅ | Correct routing behavior |
| Full `tool_choice` control | ❌ | Not honored |

---

## 5) Provider Capability Flags

| Capability | `anthropic` | `anthropic-copilot` |
|---|---:|---:|
| streaming | ✅ | ✅ |
| function calling | ✅ | ✅ |
| vision | ✅ | ❌ |
| extended thinking | ✅ | ❌ |

---

## 6) Test Evidence

Executed:

- `cd packages/daemon && bun test tests/unit/providers/anthropic-copilot --timeout 120000`

Result:

- **185 passed, 0 failed**

Coverage includes:

- SSE flow and termination paths
- `tool_use` / `tool_result` round-trip
- Parallel tool-call batching
- Continuation routing (including omitted `tools` on follow-up)
- Error, timeout, and disconnect handling
- Provider auth/env wiring

---

## Final Assessment

### Achieved

- Reliable Anthropic-like streaming behavior for HyperNeo SDK workflows.
- End-to-end tool bridging with continuation and parallel tool support.

### Not Achieved

- Full Anthropic API feature parity as a general drop-in replacement.
- Full parameter parity, non-streaming parity, usage/token accounting parity, and multimodal parity.

### Bottom line

This is best described as **"Anthropic-compatible for HyperNeo Claude Agent SDK workflows"**, not **"full Anthropic API parity"**.
