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
import type { NeokaiActionMessage, SlashCommand } from "../types.ts";
import type { ChatMessage } from "../state-types.ts";

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
 * Check if message is a stream event (partial assistant message)
 */
export function isSDKStreamEvent(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "stream_event" }> {
  return msg.type === "stream_event";
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
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "thinking"; thinking: string; signature?: string }
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
  name: "AskUserQuestion";
} {
  return block.type === "tool_use" && block.name === "AskUserQuestion";
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
): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text";
}

/**
 * Check if content block is a tool use block
 */
export function isToolUseBlock(
  block: ContentBlock,
): block is Extract<ContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
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
): block is Extract<ContentBlock, { type: "thinking" }> {
  return block.type === "thinking";
}

/**
 * Check if a thinking block has content that's worth rendering in the UI.
 *
 * Returns `false` for blocks with missing/empty/whitespace-only thinking
 * strings (e.g. Opus 4.7 omitted-thinking stubs), so renderers can avoid
 * showing an empty "Thinking · 0 characters" card.
 */
export function hasRenderableThinking(
  block: Extract<ContentBlock, { type: "thinking" }>,
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
 * System message subtypes that should never render in the chat transcript.
 * These are persisted to DB for audit/debug but hidden from UI to reduce noise.
 *
 * Hidden for these reasons:
 * - session_state_changed: Internal state machine; handler uses for turn-end detection
 * - commands_changed: Palette already updated via onCommandsChanged; chat row = noise
 * - hook_started: Redundant - hook_response carries the result
 * - hook_progress: Streaming stdout/stderr; hook_response is persisted result
 * - task_started: Task tool_use card already fires on subagent spawn
 * - task_progress: Periodic usage stats; task_notification carries final usage
 * - task_updated: Status patch; child messages + result already reflect status
 * - mirror_error: Internal group/session-mirror plumbing
 * - elicitation_complete: Niche MCP elicitation
 */
const HIDDEN_SYSTEM_SUBTYPES = new Set([
  'session_state_changed',
  'commands_changed',
  'hook_started',
  'hook_progress',
  'task_started',
  'task_progress',
  'task_updated',
  'mirror_error',
  'elicitation_complete',
]);

/**
 * Check if a system message subtype is in the explicit hidden set.
 */
export function isHiddenSystemSubtype(subtype: string): boolean {
  return HIDDEN_SYSTEM_SUBTYPES.has(subtype);
}

/**
 * Check if a message should be displayed to the user (vs internal system messages)
 */
export function isUserVisibleMessage(msg: SDKMessage): boolean {
  // User should see: assistant, user, result, tool_progress, auth_status, user replays,
  // compact_boundary, and compacting status messages
  // User should NOT see: stream events or API retry messages
  if (isSDKStreamEvent(msg)) return false;
  if (isSDKAPIRetryMessage(msg)) return false;
  if (isSDKThinkingTokensMessage(msg)) return false;

  return true;
}

/**
 * Check if a chat message is a NeoKai-native action message.
 *
 * NeoKai action messages are generated by the daemon (not the SDK) and presented
 * as interactive prompts in the chat timeline (e.g. asking the user to choose
 * between starting fresh or leaving a session as-is when the transcript file
 * cannot be found).
 */
export function isNeokaiActionMessage(msg: ChatMessage): msg is NeokaiActionMessage {
  return (msg as NeokaiActionMessage).type === 'neokai_action';
}
