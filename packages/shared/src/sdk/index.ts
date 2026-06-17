// SDK types and guards
export type * from "./sdk.d.ts";
export type * from "./sdk-tools.d.ts";

// Re-export type guards with explicit exports to avoid conflicts
// We exclude AskUserQuestionInput since it's already exported from sdk-tools.d.ts
export {
  flattenSDKSlashCommands,
  isSDKAssistantMessage,
  isSDKUserMessage,
  isSDKUserMessageReplay,
  isSDKResultMessage,
  isSDKResultSuccess,
  isSDKResultError,
  isSDKSystemMessage,
  isSDKSystemInit,
  isSDKCompactBoundary,
  isSDKStatusMessage,
  isSDKHookResponse,
  isSDKAPIRetryMessage,
  isSDKStreamEvent,
  isSDKToolProgressMessage,
  isSDKAuthStatusMessage,
  isTextBlock,
  isToolUseBlock,
  isThinkingBlock,
  isAskUserQuestionToolUse,
  extractAskUserQuestion,
  hasAskUserQuestion,
  getMessageTypeDescription,
  isUserVisibleMessage,
  isNeokaiActionMessage,
  type ContentBlock,
  type SDKSlashCommand,
} from "./type-guards.ts";
