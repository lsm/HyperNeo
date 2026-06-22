/**
 * SDK Message Renderer - Routes SDK messages to appropriate renderers
 */

import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type {
  SDKAuthStatusMessage,
  SDKMessage,
  SDKRateLimitEvent as SDKRateLimitEventType,
  SDKTaskNotificationMessage,
  SDKToolProgressMessage as SDKToolProgressMessageType,
} from '@neokai/shared/sdk/sdk.d.ts';
import type {
  PendingUserQuestion,
  QuestionDraftResponse,
  ResolvedQuestion,
  ChatMessage,
  NeokaiActionMessage,
} from '@neokai/shared';
import {
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKSystemInit,
  isSDKToolProgressMessage,
  isSDKAuthStatusMessage,
  isSDKRateLimitEvent,
  isSDKUserMessage,
  isSDKUserMessageReplay,
  isUserVisibleMessage,
  isNeokaiActionMessage,
  isHiddenSystemSubtype,
} from '@neokai/shared/sdk/type-guards';

// Component imports
import { SDKAssistantMessage } from './SDKAssistantMessage.tsx';
import { SDKRateLimitEvent } from './SDKRateLimitEvent.tsx';
import { SDKResultMessage } from './SDKResultMessage.tsx';
import { SDKSystemMessage } from './SDKSystemMessage.tsx';
import { SDKToolProgressMessage } from './SDKToolProgressMessage.tsx';
import { SDKUserMessage } from './SDKUserMessage.tsx';
import { AuthStatusCard } from './tools/index.ts';
import { SDKResumeChoiceMessage } from './SDKResumeChoiceMessage.tsx';
import type { MessageReplacementStatus } from '../../lib/sdk-message-replacement';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

interface Props {
  message: ChatMessage;
  toolResultsMap?: Map<string, unknown>;
  toolInputsMap?: Map<string, unknown>;
  subagentMessagesMap?: Map<string, SDKMessage[]>;
  /** tool_use_id → terminal task_notification (folded onto the tool card). */
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  /** tool_use_ids whose card is rendered in this slice — gates task_notification
   * suppression (a nested tool_use whose parent is paginated out has no target). */
  foldableToolUseIds?: Set<string>;
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  sessionInfo?: SystemInitMessage; // Optional session init info to attach to user messages
  // Question handling props for inline QuestionPrompt rendering
  sessionId?: string;
  resolvedQuestions?: Map<string, ResolvedQuestion>;
  pendingQuestion?: PendingUserQuestion | null;
  onQuestionResolved?: (
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[]
  ) => void;
  onRewind?: (uuid: string) => void; // Rewind to this message
  rewindingMessageUuid?: string | null; // UUID of message currently being rewound (shows spinner)
  /** When true, renders all message types without skipping (for task conversation timelines) */
  taskContext?: boolean;
  /**
   * When true, keeps sub-agent child messages in the main feed instead of
   * suppressing them in favor of nested SubagentBlock rendering.
   */
  showSubagentMessages?: boolean;
  /**
   * When true, renders Task/Agent tool_use blocks as normal tool cards instead
   * of SubagentBlock.
   */
  flattenSubagentTools?: boolean;
  /** When true, user messages containing tool_result blocks are rendered. */
  showToolResultUserMessages?: boolean;
  /**
   * When true, the last non-terminal event message in a compact task thread is
   * still executing. The receiving component wraps its visible boundary element
   * (e.g. the assistant message bubble or tool card) in <RunningBorder> so the
   * animated arc traces exactly that element's rounded-rect border.
   */
  isRunning?: boolean;
  /** Visual marker for messages superseded/retracted by later SDK rows. */
  replacementStatus?: MessageReplacementStatus;
  /** True when this row is the latest visible SDK row in the session stream. */
  isLiveTail?: boolean;
}

function ReplacementStatusFrame({
  status,
  children,
}: {
  status: MessageReplacementStatus;
  children: JSX.Element;
}) {
  const isRetracted = status === 'retracted';
  return (
    <div
      class={`my-1 rounded-lg border px-2 py-1 ${
        isRetracted ? 'border-rose-500/45 bg-rose-500/5' : 'border-amber-500/45 bg-amber-500/5'
      }`}
      data-message-replacement-status={status}
    >
      <div
        class={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
          isRetracted ? 'text-rose-500 dark:text-rose-300' : 'text-amber-600 dark:text-amber-300'
        }`}
      >
        {isRetracted ? 'Retracted by fallback' : 'Superseded by replacement'}
      </div>
      <div class="opacity-80">{children}</div>
    </div>
  );
}

/**
 * Check if message is a sub-agent message (has parent_tool_use_id) or carries an
 * agent_id that matches a known Task/Agent tool_use id. Sub-agent messages are
 * shown inside SubagentBlock, not as separate messages.
 */
function isSubagentMessage(
  message: SDKMessage,
  subagentMessagesMap?: Map<string, SDKMessage[]>
): boolean {
  const msgWithParent = message as SDKMessage & {
    parent_tool_use_id?: string | null;
  };
  if (msgWithParent.parent_tool_use_id) return true;
  const agentId = (message as { agent_id?: string | null }).agent_id;
  if (agentId && subagentMessagesMap?.has(agentId)) return true;
  return false;
}

function isRenderableSystemMessage(message: SDKMessage): boolean {
  if (!isSDKSystemMessage(message)) return false;
  const subtype = (message as { subtype?: unknown }).subtype as string;
  // Render system messages unless they're in the explicit hidden set
  return !isHiddenSystemSubtype(subtype);
}

function isToolResultUserMessage(message: SDKMessage): boolean {
  if (!isSDKUserMessage(message) && !isSDKUserMessageReplay(message)) return false;
  const content = message.message.content;
  return (
    Array.isArray(content) &&
    content.some((block: unknown) => (block as Record<string, unknown>).type === 'tool_result')
  );
}

/**
 * Compact renderer for system/init messages in task context
 */
function SystemInitPill({ message }: { message: SystemInitMessage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="py-1 px-2">
      <button
        onClick={() => setExpanded(!expanded)}
        class="flex items-center gap-2 text-[10px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
      >
        <svg
          class={`w-3 h-3 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span class="font-medium">{message.model ?? 'unknown model'}</span>
        {message.mcp_servers && message.mcp_servers.length > 0 && (
          <span>
            · {message.mcp_servers.length} MCP server
            {message.mcp_servers.length !== 1 ? 's' : ''}
          </span>
        )}
        {message.tools && <span>· {message.tools.length} tools</span>}
      </button>

      {expanded && (
        <div class="mt-1.5 ml-5 space-y-1.5 text-[10px] text-gray-500">
          {message.cwd && (
            <div>
              <span class="font-semibold text-gray-600 dark:text-gray-400">cwd: </span>
              <span class="font-mono">{message.cwd}</span>
            </div>
          )}

          {message.mcp_servers && message.mcp_servers.length > 0 && (
            <div>
              <span class="font-semibold text-gray-600 dark:text-gray-400">MCP Servers: </span>
              {message.mcp_servers.map((server: { name: string; status: string }) => (
                <span key={server.name} class="font-mono">
                  {server.name}
                  <span
                    class={
                      server.status === 'connected' ? 'text-green-600 dark:text-green-400' : ''
                    }
                  >
                    ({server.status})
                  </span>{' '}
                </span>
              ))}
            </div>
          )}

          {message.tools && message.tools.length > 0 && (
            <div>
              <span class="font-semibold text-gray-600 dark:text-gray-400">
                Tools ({message.tools.length}):{' '}
              </span>
              <span class="font-mono">{message.tools.join(', ')}</span>
            </div>
          )}

          {message.agents && message.agents.length > 0 && (
            <div>
              <span class="font-semibold text-gray-600 dark:text-gray-400">
                Agents ({message.agents.length}):{' '}
              </span>
              <span class="font-mono">{message.agents.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Main SDK message renderer - routes to appropriate sub-renderer
 */
function SDKMessageRendererImpl({
  message,
  toolResultsMap,
  toolInputsMap,
  subagentMessagesMap,
  taskNotificationsMap,
  foldableToolUseIds,
  replacementStatusMap,
  sessionInfo,
  sessionId,
  resolvedQuestions,
  pendingQuestion,
  onQuestionResolved,
  onRewind,
  rewindingMessageUuid,
  taskContext,
  showSubagentMessages = false,
  flattenSubagentTools = false,
  showToolResultUserMessages = false,
  isRunning,
  replacementStatus,
  isLiveTail = false,
}: Props) {
  // NeoKai-native action messages are always shown and handled separately.
  if (isNeokaiActionMessage(message)) {
    const actionMsg = message as NeokaiActionMessage;
    if (actionMsg.action === 'sdk_resume_choice') {
      return (
        <SDKResumeChoiceMessage message={actionMsg} sessionId={sessionId ?? actionMsg.session_id} />
      );
    }
    // Unknown action type — render nothing
    return null;
  }

  // The remaining message is a native SDKMessage.
  const sdkMessage = message as SDKMessage;

  // Skip messages that shouldn't be shown to user (e.g., stream events)
  if (!isUserVisibleMessage(sdkMessage) && !isRenderableSystemMessage(sdkMessage)) {
    return null;
  }

  // Skip session init messages - they're now shown as indicators attached to user messages
  // In task context, render them as compact info pills
  if (isSDKSystemInit(sdkMessage)) {
    if (taskContext) {
      return <SystemInitPill message={sdkMessage as SystemInitMessage} />;
    }
    return null;
  }

  // Skip sub-agent messages - they're now shown inside SubagentBlock.
  // Exception: a nested task_notification. If its parent card is in the slice
  // it's folded onto the nested ToolResultCard (suppressed below); if the parent
  // was paginated out it must render the fallback row. Either way don't drop it
  // here — the task_notification branch below decides fold vs fallback.
  if (
    !showSubagentMessages &&
    isSubagentMessage(sdkMessage, subagentMessagesMap) &&
    !(
      isSDKSystemMessage(sdkMessage) &&
      (sdkMessage as { subtype?: string }).subtype === 'task_notification'
    )
  ) {
    return null;
  }

  if (!showToolResultUserMessages && isToolResultUserMessage(sdkMessage)) {
    return null;
  }

  // task_notification is folded onto its originating tool_use card (green
  // check / red X + summary + usage). Suppress the standalone system row only
  // when that tool_use's card is actually rendered in the current paginated
  // slice — verified via `foldableToolUseIds` (top-level tool_uses + nested
  // tool_uses whose parent Task/Agent card is present). A nested tool_use
  // whose parent SubagentBlock was paginated out has no render target, so its
  // notification must fall back to a row. A true orphan (no tool_use_id) also
  // falls through to SDKSystemMessage.
  if (
    isSDKSystemMessage(sdkMessage) &&
    (sdkMessage as { subtype?: string }).subtype === 'task_notification'
  ) {
    const toolUseId = (sdkMessage as { tool_use_id?: string }).tool_use_id;
    if (toolUseId && foldableToolUseIds?.has(toolUseId)) {
      return null;
    }
  }

  // Compute the rendered message component
  let renderedMessage: JSX.Element | null = null;

  // Route to appropriate renderer based on message type
  // Handle user replay messages (slash command responses) first
  if (isSDKUserMessageReplay(sdkMessage)) {
    renderedMessage = (
      <SDKUserMessage
        message={sdkMessage}
        sessionInfo={sessionInfo}
        isReplay={true}
        sessionId={sessionId}
        showToolResultMessages={showToolResultUserMessages}
      />
    );
  } else if (isSDKUserMessage(sdkMessage)) {
    // Always render user messages - pass rewind mode props
    renderedMessage = (
      <SDKUserMessage
        message={sdkMessage}
        sessionInfo={sessionInfo}
        sessionId={sessionId}
        onRewind={onRewind}
        rewindingMessageUuid={rewindingMessageUuid}
        showToolResultMessages={showToolResultUserMessages}
      />
    );
  } else if (isSDKAssistantMessage(sdkMessage)) {
    renderedMessage = (
      <SDKAssistantMessage
        message={sdkMessage}
        toolResultsMap={toolResultsMap}
        subagentMessagesMap={subagentMessagesMap}
        taskNotificationsMap={taskNotificationsMap}
        replacementStatusMap={replacementStatusMap}
        sessionId={sessionId}
        resolvedQuestions={resolvedQuestions}
        pendingQuestion={pendingQuestion}
        onQuestionResolved={onQuestionResolved}
        flattenSubagentTools={flattenSubagentTools}
        isRunning={isRunning}
      />
    );
  } else if (isSDKResultMessage(sdkMessage)) {
    renderedMessage = <SDKResultMessage message={sdkMessage} />;
  } else if (isSDKSystemMessage(sdkMessage)) {
    renderedMessage = <SDKSystemMessage message={sdkMessage} isLiveTail={isLiveTail} />;
  } else if (isSDKToolProgressMessage(sdkMessage)) {
    const toolInput = toolInputsMap?.get((sdkMessage as SDKToolProgressMessageType).tool_use_id);
    renderedMessage = <SDKToolProgressMessage message={sdkMessage} toolInput={toolInput} />;
  } else if (isSDKAuthStatusMessage(sdkMessage)) {
    const authMessage = sdkMessage as SDKAuthStatusMessage;
    renderedMessage = (
      <AuthStatusCard
        isAuthenticating={authMessage.isAuthenticating}
        output={authMessage.output}
        error={authMessage.error}
        variant="default"
      />
    );
  } else if (isSDKRateLimitEvent(sdkMessage)) {
    renderedMessage = <SDKRateLimitEvent message={sdkMessage as SDKRateLimitEventType} />;
  } else {
    // Fallback for unknown message types (shouldn't happen, but safe)
    renderedMessage = (
      <div class="p-3 bg-gray-100 dark:bg-gray-800 rounded">
        <div class="text-xs text-gray-600 dark:text-gray-400 mb-1">
          Unknown message type: {sdkMessage.type}
        </div>
        <details>
          <summary class="text-xs cursor-pointer text-gray-500">Show raw data</summary>
          <pre class="text-xs mt-2 overflow-x-auto">{JSON.stringify(sdkMessage, null, 2)}</pre>
        </details>
      </div>
    );
  }

  if (!renderedMessage || !replacementStatus) {
    return renderedMessage;
  }

  return (
    <ReplacementStatusFrame status={replacementStatus}>{renderedMessage}</ReplacementStatusFrame>
  );
}

function areMessageRendererPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.message === next.message &&
    prev.toolResultsMap === next.toolResultsMap &&
    prev.toolInputsMap === next.toolInputsMap &&
    prev.subagentMessagesMap === next.subagentMessagesMap &&
    prev.taskNotificationsMap === next.taskNotificationsMap &&
    prev.foldableToolUseIds === next.foldableToolUseIds &&
    prev.replacementStatusMap === next.replacementStatusMap &&
    prev.sessionInfo === next.sessionInfo &&
    prev.sessionId === next.sessionId &&
    prev.resolvedQuestions === next.resolvedQuestions &&
    prev.pendingQuestion === next.pendingQuestion &&
    prev.onQuestionResolved === next.onQuestionResolved &&
    prev.onRewind === next.onRewind &&
    prev.rewindingMessageUuid === next.rewindingMessageUuid &&
    prev.taskContext === next.taskContext &&
    prev.showSubagentMessages === next.showSubagentMessages &&
    prev.flattenSubagentTools === next.flattenSubagentTools &&
    prev.showToolResultUserMessages === next.showToolResultUserMessages &&
    prev.isRunning === next.isRunning &&
    prev.replacementStatus === next.replacementStatus &&
    prev.isLiveTail === next.isLiveTail
  );
}

/**
 * Memoized to keep large SDK threads responsive: streaming appends often update
 * only one or two message objects, so unchanged rows can skip re-running the
 * tool/result routing and markdown/tool block rendering work.
 */
export const SDKMessageRenderer = memo(SDKMessageRendererImpl, areMessageRendererPropsEqual);
