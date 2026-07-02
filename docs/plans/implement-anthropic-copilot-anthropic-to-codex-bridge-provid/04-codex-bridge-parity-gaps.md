# Milestone 4: Codex Bridge Parity Gaps

## Goal

Close the most impactful parity gaps in the `anthropic-to-codex-bridge` provider (backed by `codex app-server`). These gaps block real HyperNeo usability with the Codex backend.

## Scope

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts` -- Multiple tool results, error envelopes, diagnostic cleanup
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts` -- `tool_choice` pass-through
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts` -- Token usage wiring
- `packages/daemon/tests/unit/providers/codex-anthropic-bridge/` -- Unit tests for all changes

> **Prerequisite cleanup:** `server.ts` lines 93-96 contain a leftover `process.stderr.write` diagnostic log (`[codex-bridge-server] drainToSSE event: ...`) that fires on every streaming event. This violates CLAUDE.md's `no-console` rule and must be replaced with the existing `logger` or removed entirely. This cleanup is included in Task 4.2 (error envelopes).

---

### Task 4.1: Support Multiple Tool Results in Codex Bridge

**Description:** The bridge currently uses only `toolResults[0]` when resuming a suspended session. This breaks multi-tool round-trips where the Codex model emits multiple tool calls in a single turn. Fix the server to resume with all tool results.

**Agent type:** coder

**Architecture context:** The bridge stores one suspended `ToolSession` per `callId` in a `Map` keyed by `tool_use_id`. Each `BridgeSession.provideResult(callId, result)` is a deferred resolver that unblocks the Codex read loop for that specific tool call. When the Anthropic client sends multiple `tool_result` blocks in one request, each block has a **different** `tool_use_id`, corresponding to a different suspended `ToolSession`.

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts` -- find the `toolResults[0]` usage (line 240).
3. Read `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts` to understand:
   - How `BridgeSession` stores suspended `ToolSession` instances (Map keyed by `tool_use_id`).
   - How `provideResult(callId, result)` resolves the deferred for a specific tool call.
   - Whether the Codex app-server can emit multiple tool calls in a single turn.
4. Modify the server to iterate over **all** `toolResults` and call `provideResult` for each:
   - For each `tool_result` block, look up the corresponding suspended `ToolSession` by its `tool_use_id` and call `provideResult`.
   - If a `tool_use_id` does not have a matching suspended session (orphaned result), log a warning and skip it.
   - If the Codex app-server only ever emits one tool call per turn (making multiple results impossible in practice), document this as a known limitation in a code comment but still handle the multi-result path correctly for forward compatibility.
5. **Expected behavior when multiple results arrive but only one can be processed:** If the bridge only has one suspended `ToolSession` (because Codex emitted one tool call), resolve that one and log a warning for any extra `tool_result` blocks with unmatched `tool_use_id`s. Do **not** silently drop them.
6. Add unit tests in `packages/daemon/tests/unit/providers/codex-anthropic-bridge/server.test.ts` covering:
   - Single tool result (existing behavior preserved).
   - Multiple tool results in one continuation request, each with a matching suspended session.
   - Multiple tool results where some `tool_use_id`s have no matching suspended session (warning logged, non-matching results skipped).
7. Run `bun run typecheck` and `bun run lint`.
8. Run `cd packages/daemon && bun test tests/unit/providers/codex-anthropic-bridge/`.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- The bridge iterates all `toolResults` and resolves each by its `tool_use_id`, not just `toolResults[0]`.
- Orphaned tool results (no matching suspended session) produce a warning log, not a silent drop or crash.
- If the Codex backend only supports one tool call per turn, this is documented as a known limitation in code comments.
- Unit tests cover: single result, multiple results with matching sessions, and unmatched result IDs.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 4.2: Anthropic-Style JSON Error Envelopes for Codex Bridge

**Description:** The bridge currently returns plain-text HTTP error bodies and embeds errors as `[Codex error: ...]` text blocks in SSE responses. Replace these with Anthropic-standard JSON error envelopes for HTTP errors and Anthropic-style `error` SSE events for streaming errors.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read the Anthropic API error format documentation. Standard shape:
   ```json
   {"type":"error","error":{"type":"<error_type>","message":"<message>"}}
   ```
   Error types: `invalid_request_error`, `authentication_error`, `not_found_error`, `api_error`, `overloaded_error`.
3. In `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`:
   - **Cleanup first:** Remove the leftover `process.stderr.write` diagnostic log on lines 93-96 (`[codex-bridge-server] drainToSSE event: ...`). Replace with the existing `logger.debug()` if any logging is still needed, or remove entirely.
   - Replace all plain-text error responses (400, 404, 500) with JSON bodies matching the Anthropic error envelope format.
   - For streaming errors, emit an `error` SSE event with the Anthropic error JSON before closing the stream.
4. Add a helper function `createAnthropicError(httpStatus: number, type: string, message: string)` in the translator or server to standardize error creation.
5. Add unit tests covering:
   - 400 Bad Request returns proper JSON envelope.
   - 404 Session Not Found returns proper JSON envelope.
   - 500 Internal Server Error returns proper JSON envelope.
   - Streaming error emits an `error` SSE event.
6. Run `bun run typecheck` and `bun run lint`.
7. Run `cd packages/daemon && bun test tests/unit/providers/codex-anthropic-bridge/`.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- All HTTP error responses use Anthropic JSON error envelope format.
- Streaming errors emit an `error` SSE event with Anthropic-format payload.
- No more plain-text error bodies in the codex bridge server.
- Unit tests verify error envelope format for all error paths.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 4.3: Wire Token Usage from Codex Bridge

**Description:** The bridge emits synthetic/zero `input_tokens` and heuristic `output_tokens`. Wire the `thread/tokenUsage/updated` notification from the Codex app-server process manager to populate accurate usage fields in the SSE `message_delta` event.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts`:
   - Find how `thread/tokenUsage/updated` events are received.
   - Understand the token usage data shape from the app-server.
3. In `process-manager.ts`:
   - Capture token usage from the `thread/tokenUsage/updated` notification.
   - Expose it via `BridgeSession` (e.g., `getUsage()` method or an event emitter).
4. In `server.ts`:
   - When building the `message_delta` SSE event, use actual token usage from the bridge session if available.
   - Fall back to heuristic estimation if the notification has not yet arrived.
5. In `translator.ts`, update the `messageDeltaSSE` helper to accept actual usage values.
6. Add unit tests covering:
   - Token usage is captured from app-server notification.
   - `message_delta` SSE event includes actual token counts when available.
   - Fallback to heuristic when no notification arrives.
7. Run `bun run typecheck` and `bun run lint`.
8. Run `cd packages/daemon && bun test tests/unit/providers/codex-anthropic-bridge/`.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Token usage from `thread/tokenUsage/updated` is captured and exposed.
- SSE `message_delta` events include actual token counts when available.
- Fallback to heuristic estimation works when no notification arrives.
- Unit tests verify usage wiring.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1
