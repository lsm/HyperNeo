# Codex Anthropic Bridge API Parity Review

> **Note:** This report has been superseded by `docs/reports/provider-parity-final-report.md`.

Date: 2026-03-16

## Verdict

No — the current bridge does **not** have full Anthropic API parity.

It has **working partial parity** for the path HyperNeo currently uses:

- `POST /v1/messages`
- streaming SSE
- plain text replies
- single tool-use round trip
- basic system prompt support
- basic MCP-style tool name mapping

That is enough for the current HyperNeo Codex bridge flow, but it is **not** a full Anthropic-compatible implementation.

## What is solid today

### 1. Basic streaming Messages flow works

Implemented in:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts`

The bridge correctly emits Anthropic-style SSE events:

- `message_start`
- `ping`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`

### 2. Single-tool round trip works

The bridge can:

- emit `tool_use`
- suspend the Codex session
- accept a later `tool_result`
- resume and finish the turn

Covered by:

- `packages/daemon/tests/online/providers/anthropic-to-codex-bridge-provider.test.ts`
- `packages/daemon/tests/unit/providers/codex-anthropic-bridge/server.test.ts`

### 3. API-key auth now works correctly

The bridge now uses explicit app-server RPC login:

- `account/login/start { type: 'apiKey', apiKey: ... }`

instead of relying on env injection.

## Main parity gaps

### A. Only a minimal subset of Anthropic Messages request fields is supported

`packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts` currently models only:

- `model`
- `messages`
- `system`
- `tools`
- `max_tokens`
- `stream`

Missing or not implemented:

- `tool_choice`
- `temperature`
- `top_p`
- `top_k`
- `stop_sequences`
- `metadata`
- `thinking`
- multimodal blocks like images/documents
- newer Anthropic beta fields

#### Why this matters

The online tests currently use a system-prompt workaround to force tool use instead of true Anthropic `tool_choice` behavior:

- `packages/daemon/tests/online/providers/codex-bridge.test.ts:211`
- `packages/daemon/tests/online/providers/codex-bridge.test.ts:303`

That is a clear sign we do **not** have tool-choice parity yet.

### B. `stream: false` is not supported

The server always returns SSE from `/v1/messages`, regardless of the request body.

Relevant implementation:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`

If a client sends `stream: false`, it still gets an SSE response rather than an Anthropic JSON response body.

### C. Only `/v1/messages` is implemented

The bridge currently handles only:

- `/health`
- `/v1/health`
- `/v1/messages`

Relevant implementation:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`

Missing Anthropic-compatible surface area includes endpoints such as:

- `/v1/messages/count_tokens`
- other future Anthropic endpoints that clients may expect

### D. Conversation semantics are only approximate

The bridge does not preserve Anthropic’s structured conversation model exactly. Instead, it flattens history into text:

- system → `<system>...</system>`
- prior turns → `<conversation>...</conversation>`
- current turn → plain text input

Relevant implementation:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts`

`extractContentText()` also only preserves text blocks and ignores structure from prior tool blocks.

#### Consequences

These Anthropic semantics are not faithfully preserved:

- prior assistant `tool_use` structure
- prior user `tool_result` structure
- mixed content blocks
- multimodal content
- exact turn boundaries and block structure

So the bridge is Anthropic-shaped, but not Anthropic-equivalent.

### E. Multiple tool results are not really supported

The translator extracts all tool results from the last user message, but the HTTP bridge resumes using only the first one:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`

The server currently does:

```ts
const tr = toolResults[0];
```

So Anthropic-style requests carrying multiple `tool_result` blocks in one turn are not fully supported.

### F. Usage/token accounting is not Anthropic-accurate

Current behavior:

- `message_start` emits synthetic or placeholder usage values
- input token counts are effectively `0`
- output token counts are estimated heuristically from text length
- Codex token usage notifications are not wired through

Relevant implementation/comments:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts`
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`

`process-manager.ts` explicitly notes that token usage arrives separately via `thread/tokenUsage/updated`, but no handler currently feeds that into Anthropic usage fields.

### G. Error behavior does not match Anthropic

When the bridge encounters an internal or Codex-side error during streaming, it emits an assistant text block like:

```text
[Codex error: ...]
```

Relevant implementation:

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`

HTTP errors also return plain-text bodies such as:

- `Bad Request`
- `Session not found`
- `Internal Server Error: ...`

These are not Anthropic-style JSON error envelopes.

### H. Header / protocol compatibility is loose, not strict

The bridge does not validate or use standard Anthropic request headers like:

- `x-api-key`
- `anthropic-version`
- `anthropic-beta`

It accepts JSON and returns responses without enforcing Anthropic protocol details.

### I. Multimodal parity is absent

Supported content block types in the translator are only:

- `text`
- `tool_use`
- `tool_result`

There is no support for Anthropic-style:

- image blocks
- document blocks
- thinking blocks
- redacted thinking
- citation-related output structures

### J. Stop behavior parity is incomplete

The bridge can emit stop reasons such as:

- `end_turn`
- `tool_use`
- `max_tokens`

But in practice:

- `max_tokens` is not meaningfully enforced
- `stop_sequences` are not supported
- stop reasons are bridge-generated rather than derived from full Anthropic semantics

### K. Tests prove the happy path, not full parity

Current tests cover:

- text streaming
- one tool call
- one tool continuation
- MCP name translation
- session TTL cleanup
- model preservation

Current tests do **not** cover:

- `stream: false`
- `tool_choice`
- multiple `tool_result` blocks
- images/documents
- `stop_sequences`
- token usage correctness
- Anthropic-style JSON error bodies
- header/version handling
- mixed content blocks across multi-turn history

## Practical conclusion

The current bridge should be described as:

> Anthropic-compatible enough for HyperNeo’s current streaming and tool-use integration, but not a full Anthropic API implementation.

## Rough parity estimate

If “full Anthropic API parity” is the target:

- transport/path parity: medium
- streaming event-shape parity: medium-good
- tool-use parity: medium for single-tool turns
- request schema parity: low
- response semantics parity: low-medium
- error parity: low
- multimodal parity: none
- usage/accounting parity: low

Overall: **partial, not full**.

## Recommended next priorities

If the goal is true Anthropic drop-in compatibility, the highest-priority gaps are:

1. Support `stream: false`
2. Implement `tool_choice`
3. Handle multiple `tool_result` blocks
4. Wire real token usage from `thread/tokenUsage/updated`
5. Return Anthropic-style JSON error envelopes
6. Preserve structured conversation more faithfully instead of flattening everything into text
7. Add multimodal block support
8. Add `/v1/messages/count_tokens` if HyperNeo or future clients need it

## Bottom line

If the goal is:

### “Enough for HyperNeo to use Codex behind an Anthropic-shaped SDK”

The bridge is close and likely sufficient for the current narrow path.

### “A true Anthropic-compatible API surface”

We are **not there yet**.
