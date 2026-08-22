
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

export function isSDKAssistantMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "assistant" }> {
  return msg.type === "assistant";
}

export function isSDKUserMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "user" }> {
  const msgWithReplay = msg as SDKMessage & { isReplay?: boolean };
  return (
    msg.type === "user" &&
    (!("isReplay" in msg) || msgWithReplay.isReplay === false)
  );
}

export function isSDKUserMessageReplay(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "user"; isReplay: true }> {
  return msg.type === "user" && "isReplay" in msg && msg.isReplay === true;
}

export function isSDKResultMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "result" }> {
  return msg.type === "result";
}

export function isSDKResultSuccess(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "result"; subtype: "success" }> {
  return msg.type === "result" && (msg as SDKResultMessage).subtype === "success";
}

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

export function isSDKSystemMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system" }> {
  return msg.type === "system";
}

export function isSDKSystemInit(
  msg: SDKMessage,
): msg is SDKSystemMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "init";
}

export function isSDKCommandsChangedMessage(
  msg: SDKMessage,
): msg is SDKCommandsChangedMessage {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "commands_changed";
}

export function isSDKCompactBoundary(
  msg: SDKMessage,
): msg is SDKCompactBoundaryMessage {
  return msg.type === "system" && (msg as SDKCompactBoundaryMessage).subtype === "compact_boundary";
}

export function isSDKStatusMessage(
  msg: SDKMessage,
): msg is SDKStatusMessage {
  return msg.type === "system" && (msg as SDKStatusMessage).subtype === "status";
}

export function isSDKHookResponse(
  msg: SDKMessage,
): msg is SDKHookResponseMessage {
  return msg.type === "system" && (msg as SDKHookResponseMessage).subtype === "hook_response";
}

export function isSDKAPIRetryMessage(
  msg: SDKMessage,
): msg is SDKAPIRetryMessage {
  return msg.type === "system" && (msg as SDKAPIRetryMessage).subtype === "api_retry";
}

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

export function isSDKModelRefusalNoFallbackMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "model_refusal_no_fallback" }> {
  return (
    msg.type === "system" && (msg as { subtype?: string }).subtype === "model_refusal_no_fallback"
  );
}

export function isSDKSessionStateChangedMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "session_state_changed" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "session_state_changed";
}

export function isSDKBackgroundTasksChangedMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "background_tasks_changed" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "background_tasks_changed";
}

export function isSDKControlRequestProgressMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "control_request_progress" }> {
  return msg.type === "system" && (msg as { subtype?: string }).subtype === "control_request_progress";
}

export function isSDKStreamEvent(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "stream_event" }> {
  return msg.type === "stream_event";
}

export function isSDKCommandLifecycleMessage(msg: SDKMessage): boolean {
  return (msg as { type?: string }).type === "command_lifecycle";
}

export function isSDKConversationResetMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "conversation_reset" }> {
  return msg.type === "conversation_reset";
}

export function isSDKActiveGoalMessage(msg: SDKMessage): boolean {
  return (msg as { type?: string }).type === "active_goal";
}

export function isSDKToolProgressMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "tool_progress" }> {
  return msg.type === "tool_progress";
}

export function isSDKAuthStatusMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "auth_status" }> {
  return msg.type === "auth_status";
}

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

export type ContentBlock =
  | SDKAssistantContentBlock
  | TextContentBlock
  | ToolUseContentBlock
  | ThinkingContentBlock
  | { type: "redacted_thinking"; data: string };

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

/** @public */
export function hasAskUserQuestion(msg: SDKMessage): boolean {
  return extractAskUserQuestion(msg) !== null;
}

export function isTextBlock(
  block: ContentBlock,
): block is TextContentBlock {
  return block.type === "text" && typeof block.text === "string";
}

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

export function isThinkingBlock(
  block: ContentBlock,
): block is ThinkingContentBlock {
  return block.type === "thinking" && typeof block.thinking === "string";
}

export function hasRenderableThinking(
  block: ThinkingContentBlock,
): boolean {
  return typeof block.thinking === "string" && block.thinking.trim().length > 0;
}

/** @public */
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

export const HIDDEN_SYSTEM_SUBTYPES = new Set([
  'session_state_changed',
  'commands_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'mirror_error',
  'elicitation_complete',
  'background_tasks_changed',
  'control_request_progress',
]);

export function isHiddenSystemSubtype(subtype: string): boolean {
  return HIDDEN_SYSTEM_SUBTYPES.has(subtype);
}

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

export function isUserVisibleMessage(msg: SDKMessage): boolean {
  if (isSDKStreamEvent(msg)) return false;
  if (isSDKThinkingTokensMessage(msg)) return false;
  if (isSDKCommandLifecycleMessage(msg)) return false;
  if (isSDKConversationResetMessage(msg)) return false;
  if (isSDKActiveGoalMessage(msg)) return false;

  return true;
}

export function isHyperNeoActionMessage(msg: ChatMessage): msg is HyperNeoActionMessage {
  return (msg as HyperNeoActionMessage).type === 'hyperneo_action';
}
