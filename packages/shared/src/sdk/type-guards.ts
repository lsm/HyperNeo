/**
 * Type guards for SDK message types
 *
 * These type guards enable type-safe discrimination of SDK message union types.
 */

import type {
  SDKAPIRetryMessage,
  SDKMessage,
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKCommandsChangedMessage,
  SDKCompactBoundaryMessage,
  SDKHookResponseMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKThinkingTokensMessage,
  SDKToolProgressMessage,
} from "./sdk.d.ts";
import type { HyperNeoActionMessage, SlashCommand } from "../types.ts";
import type { ChatMessage } from "../state-types.ts";

type SDKAssistantContentBlock = SDKAssistantMessage["message"]["content"][number];

export type TextContentBlock = {
  type: "text";
  text: string;
  citations?: unknown;
};

export type ToolUseContentBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

export type ThinkingContentBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

// ============================================================================
// Message Type Guards
// ============================================================================

/**
 * Check if message is an Assistant message
 */
export function isSDKAssistantMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "assistant" }> {
  return msg.type === "assistant";
}

/**
 * Check if message is a User message
 */
export function isSDKUserMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "user" }> {
  const msgWithReplay = msg as SDKMessage & { isReplay?: boolean };
  return (
    msg.type === "user" &&
    (!("isReplay" in msg) || msgWithReplay.isReplay === false)
  );
}

/**
 * Check if message is a User message replay
 */
export function isSDKUserMessageReplay(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "user"; isReplay: true }> {
  return msg.type === "user" && "isReplay" in msg && msg.isReplay === true;
}

/**
 * Check if message is a Result message (any subtype)
 */
export function isSDKResultMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "result" }> {
  return msg.type === "result";
}

/**
 * Check if message is a successful Result message
 */
export function isSDKResultSuccess(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "result"; subtype: "success" }> {
  return msg.type === "result" && (msg as SDKResultMessage).subtype === "success";
}

/**
 * Check if message is an error Result message
 */
export function isSDKResultError(msg: SDKMessage): msg is Extract<
  SDKMessage,
  {
    type: "result";
    subtype:
      | "error_during_execution"
      | "error_max_turns"
      | "error_max_budget_usd"
      | "error_max_structured_output_retries";
  }
> {
  return msg.type === "result" && (msg as SDKResultMessage).subtype !== "success";
}

/**
 * Check if message is a System message (any subtype)
 */
export function isSDKSystemMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system" }> {
  return msg.type === "system";
}

/**
 * Check if message is a System init message
 */
export function isSDKSystemInit(
  msg: SDKMessage,
): msg is SDKSystemMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "init";
}

/**
 * Check if message is a commands changed message
 */
export function isSDKCommandsChangedMessage(
  msg: SDKMessage,
): msg is SDKCommandsChangedMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "commands_changed";
}

/**
 * Check if message is a compact boundary message
 */
export function isSDKCompactBoundary(
  msg: SDKMessage,
): msg is SDKCompactBoundaryMessage {
  return msg.type === "system" && (msg as SDKCompactBoundaryMessage).subtype === "compact_boundary";
}

/**
 * Check if message is a status message
 */
export function isSDKStatusMessage(
  msg: SDKMessage,
): msg is SDKStatusMessage {
  return msg.type === "system" && (msg as SDKStatusMessage).subtype === "status";
}

/**
 * Check if message is a hook response message
 */
export function isSDKHookResponse(
  msg: SDKMessage,
): msg is SDKHookResponseMessage {
  return msg.type === "system" && (msg as SDKHookResponseMessage).subtype === "hook_response";
}

/**
 * Check if message is an API retry message
 */
export function isSDKAPIRetryMessage(
  msg: SDKMessage,
): msg is SDKAPIRetryMessage {
  return msg.type === "system" && (msg as SDKAPIRetryMessage).subtype === "api_retry";
}

/**
 * Check if message is a thinking token progress message
 */
export function isSDKThinkingTokensMessage(
  msg: SDKMessage,
): msg is SDKThinkingTokensMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "thinking_tokens";
}

export function isSDKModelRefusalFallbackMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "model_refusal_fallback" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "model_refusal_fallback";
}

export function isSDKSessionStateChangedMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "session_state_changed" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "session_state_changed";
}

/**
 * Check if message is a background-tasks-changed system push (REPLACE-semantics
 * task roster). Internal state signal with no downstream consumer — filtered
 * before persistence, same as stream_event.
 */
export function isSDKBackgroundTasksChangedMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "background_tasks_changed" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "background_tasks_changed";
}

/**
 * Check if message is a control-request-progress system push (in-flight
 * control_request progress). Internal state signal with no downstream consumer
 * — filtered before persistence, same as stream_event.
 */
export function isSDKControlRequestProgressMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "control_request_progress" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "control_request_progress";
}

/**
 * Check if message is a stream event (partial assistant message)
 */
export function isSDKStreamEvent(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "stream_event" }> {
  return msg.type === "stream_event";
}

/**
 * Check if message is a command lifecycle event.
 *
 * The native Claude Code CLI (2.1.x) emits these to track a slash command's
 * queue lifecycle (`queued` → `started` → `completed`/`failed`/`cancelled`).
 * They are internal progress signals, not user-facing content, and are not
 * declared in the wrapper SDK's `SDKMessage` union — so this guard returns a
 * plain boolean (no type predicate) and filters on the raw runtime `type`.
 */
export function isSDKCommandLifecycleMessage(msg: SDKMessage): boolean {
  return (msg as { type?: string }).type === "command_lifecycle";
}

/**
 * Check if message is a conversation reset event.
 *
 * Emitted when the SDK resets the conversation (e.g. `/clear` or `/new`),
 * carrying the fresh `new_conversation_id`. A session-boundary signal, not
 * user-facing content — hidden from the transcript.
 */
export function isSDKConversationResetMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "conversation_reset" }> {
  return msg.type === "conversation_reset";
}

/**
 * Check if message is an active-goal update (`/goal` feature).
 *
 * Declared in the native CLI's raw `StdoutMessage` union but not in the
 * wrapper's `SDKMessage` union, so — like {@link isSDKCommandLifecycleMessage}
 * — this returns a plain boolean and filters on the raw runtime `type`.
 * Carries goal state, not chat content; hidden from the transcript.
 */
export function isSDKActiveGoalMessage(msg: SDKMessage): boolean {
  return (msg as { type?: string }).type === "active_goal";
}

/**
 * Check if message is a tool progress message
 */
export function isSDKToolProgressMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "tool_progress" }> {
  return msg.type === "tool_progress";
}

/**
 * Check if message is an auth status message
 */
export function isSDKAuthStatusMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "auth_status" }> {
  return msg.type === "auth_status";
}

/**
 * Check if message is a rate limit event
 */
export function isSDKRateLimitEvent(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "rate_limit_event" }> {
  return msg.type === "rate_limit_event";
}

export type SDKSlashCommand = Pick<SlashCommand, "name" | "aliases">;

function normalizeSlashCommandName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

export function flattenSDKSlashCommands(commands: SDKSlashCommand[]): string[] {
  const names = new Set<string>();
  for (const command of commands) {
    if (typeof command.name === "string" && command.name.length > 0) {
      names.add(normalizeSlashCommandName(command.name));
    }
    for (const alias of command.aliases ?? []) {
      if (typeof alias === "string" && alias.length > 0) {
        names.add(normalizeSlashCommandName(alias));
      }
    }
  }
  return [...names].filter((name) => name.length > 0);
}

// ============================================================================
// Content Block Type Guards (for Assistant messages)
// ============================================================================

/**
 * Type for content blocks from APIAssistantMessage.
 *
 * The `thinking` variant carries an optional `signature` field that Anthropic
 * returns alongside thinking output for multi-turn continuity. When the model
 * is configured with `thinking.display = 'omitted'` (the Opus 4.7 default in
 * some paths), the server returns a thinking block with a non-empty signature
 * and an *empty* `thinking` string. Renderers must treat empty thinking as
 * "no content to display" rather than rendering an empty card.
 *
 * We also accept the `redacted_thinking` variant emitted by the raw Anthropic
 * API when a thinking block is redacted for safety. The SDK normally maps
 * these into `thinking` blocks, but we include the type so the union is
 * exhaustive and renderers can skip them safely if they ever appear.
 */
export type ContentBlock =
  | SDKAssistantContentBlock
  | TextContentBlock
  | ToolUseContentBlock
  | ThinkingContentBlock
  | { type: "redacted_thinking"; data: string };

/**
 * AskUserQuestion tool input type
 * Matches the SDK's AskUserQuestionInput schema
 */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
}

/**
 * Check if a tool use block is an AskUserQuestion call
 */
export function isAskUserQuestionToolUse(block: ContentBlock): block is Extract<
  ContentBlock,
  { type: "tool_use" }
> & {
  id: string;
  name: "AskUserQuestion";
  input: Record<string, unknown>;
} {
  return (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    block.name === "AskUserQuestion" &&
    typeof block.input === "object" &&
    block.input !== null &&
    !Array.isArray(block.input)
  );
}

/**
 * Extract AskUserQuestion data from an assistant message
 * Returns null if the message doesn't contain an AskUserQuestion tool call
 */
export function extractAskUserQuestion(msg: SDKMessage): {
  toolUseId: string;
  input: AskUserQuestionInput;
} | null {
  if (!isSDKAssistantMessage(msg)) return null;

  const content = msg.message.content;
  for (const block of content) {
    if (isAskUserQuestionToolUse(block)) {
      return {
        toolUseId: block.id,
        input: block.input as unknown as AskUserQuestionInput,
      };
    }
  }

  return null;
}

/**
 * Check if an assistant message contains an AskUserQuestion tool call.
 * @public
 */
export function hasAskUserQuestion(msg: SDKMessage): boolean {
  return extractAskUserQuestion(msg) !== null;
}

/**
 * Check if content block is a text block
 */
export function isTextBlock(
  block: ContentBlock,
): block is TextContentBlock {
  return block.type === "text" && typeof block.text === "string";
}

/**
 * Check if content block is a tool use block
 */
export function isToolUseBlock(
  block: unknown,
): block is ToolUseContentBlock {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return false;
  }

  const value = block as Record<string, unknown>;
  return (
    value.type === "tool_use" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.input === undefined ||
      (typeof value.input === "object" &&
        value.input !== null &&
        !Array.isArray(value.input)))
  );
}

/**
 * Check if content block is a thinking block.
 *
 * Note: this guard matches thinking blocks regardless of whether the
 * `thinking` payload is empty. Empty thinking blocks are emitted by newer
 * Anthropic models (e.g. Opus 4.7) when `thinking.display = 'omitted'` is in
 * effect — the server still returns a thinking block carrying a signature for
 * multi-turn continuity but no textual content. Use
 * {@link hasRenderableThinking} at render time to decide whether to display
 * a thinking card.
 */
export function isThinkingBlock(
  block: ContentBlock,
): block is ThinkingContentBlock {
  return block.type === "thinking" && typeof block.thinking === "string";
}

/**
 * Check if a thinking block has content that's worth rendering in the UI.
 *
 * Returns `false` for blocks with missing/empty/whitespace-only thinking
 * strings (e.g. Opus 4.7 omitted-thinking stubs), so renderers can avoid
 * showing an empty "Thinking · 0 characters" card.
 */
export function hasRenderableThinking(
  block: ThinkingContentBlock,
): boolean {
  return typeof block.thinking === "string" && block.thinking.trim().length > 0;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get a human-readable description of a message type.
 * @public
 */
export function getMessageTypeDescription(msg: SDKMessage): string {
  if (isSDKAssistantMessage(msg)) {
    return "Assistant Response";
  }
  if (isSDKUserMessage(msg)) {
    return "User Message";
  }
  if (isSDKUserMessageReplay(msg)) {
    return "User Message (Replay)";
  }
  if (isSDKResultSuccess(msg)) {
    return "Query Success";
  }
  if (isSDKResultError(msg)) {
    const resultMsg = msg as SDKResultMessage;
    return `Query Error: ${(resultMsg.subtype).replace("error_", "")}`;
  }
  if (isSDKSystemInit(msg)) {
    return "Session Initialized";
  }
  if (isSDKCompactBoundary(msg)) {
    return "Compaction Boundary";
  }
  if (isSDKStatusMessage(msg)) {
    const statusMsg = msg as SDKStatusMessage;
    return `Status: ${statusMsg.status || "unknown"}`;
  }
  if (isSDKHookResponse(msg)) {
    const hookMsg = msg as SDKHookResponseMessage;
    return `Hook Response: ${hookMsg.hook_name}`;
  }
  if (isSDKAPIRetryMessage(msg)) {
    const retryMsg = msg as SDKAPIRetryMessage;
    return `API Retry: attempt ${retryMsg.attempt}/${retryMsg.max_retries}`;
  }
  if (isSDKStreamEvent(msg)) {
    return "Streaming Event";
  }
  if (isSDKToolProgressMessage(msg)) {
    const toolMsg = msg as SDKToolProgressMessage;
    return `Tool Progress: ${toolMsg.tool_name}`;
  }
  if (isSDKAuthStatusMessage(msg)) {
    return "Authentication Status";
  }
  return "Unknown Message";
}

/**
 * System subtypes hidden by transcript rendering.
 *
 * Do not use this set as a universal SQL exclusion list. Some render-hidden rows
 * still carry metadata consumed outside the transcript (for example
 * `task_started` / `task_updated` for SessionInfoPanel background-task state,
 * and task progress rows for runtime idle detection).
 *
 * Hidden for these reasons:
 * - session_state_changed: Internal state machine; handler uses for turn-end detection
 * - commands_changed: Palette already updated via onCommandsChanged; chat row = noise
 * - task_started: Task tool_use card already fires on subagent spawn
 * - task_progress: Periodic usage stats; task_notification carries final usage
 * - task_updated: Status patch; child messages + result already reflect status
 * - mirror_error: Internal group/session-mirror plumbing
 * - elicitation_complete: Niche MCP elicitation
 *
 * Note: hook_started / hook_progress / hook_response are NOT hidden here — the
 * chat transcript renders them (HookRunningCard / HookResponseCard). The Space
 * task thread minimal feed hides all hook_* system rows itself (hooks surface
 * only as roster entries there); see MinimalThreadFeed.buildOperationalSystemTurn.
 */
export const HIDDEN_SYSTEM_SUBTYPES = new Set([
  'session_state_changed',
  'commands_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'mirror_error',
  'elicitation_complete',
  // New in Claude Code 2.1.x (SDK 0.3.233): internal state/progress pushes.
  'background_tasks_changed',
  'control_request_progress',
]);

/**
 * Check if a system message subtype is in the explicit hidden set.
 */
export function isHiddenSystemSubtype(subtype: string): boolean {
  return HIDDEN_SYSTEM_SUBTYPES.has(subtype);
}

/**
 * Check if a system message should be hidden based on payload conditions.
 *
 * These subtypes are not universally hidden; they render only for specific
 * payload states. This helper centralises the conditional logic so the chat
 * transcript and nested subagent timelines stay consistent.
 */
export function isConditionallyHiddenSystemMessage(msg: SDKMessage): boolean {
  if (msg.type !== 'system') return false;
  const subtype = (msg as { subtype?: string }).subtype;
  if (subtype === 'files_persisted') {
    const failed = (msg as { failed?: unknown[] }).failed;
    return !Array.isArray(failed) || failed.length === 0;
  }
  if (subtype === 'plugin_install') {
    const status = (msg as { status?: string }).status;
    return status === 'started' || status === 'installed';
  }
  return false;
}

/**
 * Check if a message should be displayed to the user (vs internal system messages)
 */
export function isUserVisibleMessage(msg: SDKMessage): boolean {
  // User should see: assistant, user, result, tool_progress, auth_status, user replays,
  // compact_boundary, api_retry, and compacting status messages
  // User should NOT see: stream events or thinking_tokens deltas (transient only)
  if (isSDKStreamEvent(msg)) return false;
  if (isSDKThinkingTokensMessage(msg)) return false;
  if (isSDKCommandLifecycleMessage(msg)) return false;
  if (isSDKConversationResetMessage(msg)) return false;
  if (isSDKActiveGoalMessage(msg)) return false;

  return true;
}

/**
 * Check if a chat message is a HyperNeo-native action message.
 *
 * HyperNeo action messages are generated by the daemon (not the SDK) and presented
 * as interactive prompts in the chat timeline (e.g. asking the user to choose
 * between starting fresh or leaving a session as-is when the transcript file
 * cannot be found).
 */
export function isHyperNeoActionMessage(msg: ChatMessage): msg is HyperNeoActionMessage {
  return (msg as HyperNeoActionMessage).type === 'hyperneo_action';
}
