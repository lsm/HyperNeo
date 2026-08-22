import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type {
  SDKAuthStatusMessage,
  SDKMessage,
  SDKRateLimitEvent as SDKRateLimitEventType,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKToolProgressMessage as SDKToolProgressMessageType,
} from '@hyperneo/shared/sdk/sdk.d.ts';
import type {
  PendingUserQuestion,
  QuestionDraftResponse,
  ResolvedQuestion,
  ChatMessage,
  HyperNeoActionMessage,
} from '@hyperneo/shared';
import {
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKSystemInit,
  isSDKToolProgressMessage,
  isSDKAuthStatusMessage,
  isSDKPromptSuggestionMessage,
  isSDKRateLimitEvent,
  isSDKToolUseSummaryMessage,
  isSDKUserMessage,
  isSDKUserMessageReplay,
  isUserVisibleMessage,
  isHyperNeoActionMessage,
  isHiddenSystemSubtype,
} from '@hyperneo/shared/sdk/type-guards';

import { SDKAssistantMessage } from './SDKAssistantMessage.tsx';
import { SDKPromptSuggestionMessage } from './SDKPromptSuggestionMessage.tsx';
import { SDKRateLimitEvent } from './SDKRateLimitEvent.tsx';
import { SDKResultMessage } from './SDKResultMessage.tsx';
import { SDKSystemMessage } from './SDKSystemMessage.tsx';
import { SDKToolProgressMessage } from './SDKToolProgressMessage.tsx';
import { SDKToolUseSummaryMessage } from './SDKToolUseSummaryMessage.tsx';
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
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  taskProgressMap?: Map<string, SDKTaskProgressMessage>;
  foldableToolUseIds?: Set<string>;
  completedHookUuids?: Set<string>;
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  sessionInfo?: SystemInitMessage;
  sessionId?: string;
  resolvedQuestions?: Map<string, ResolvedQuestion>;
  pendingQuestion?: PendingUserQuestion | null;
  onQuestionResolved?: (
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[]
  ) => void;
  onRewind?: (uuid: string) => void;
  rewindingMessageUuid?: string | null;
  taskContext?: boolean;
  showSubagentMessages?: boolean;
  flattenSubagentTools?: boolean;
  showToolResultUserMessages?: boolean;
  isRunning?: boolean;
  runningToolUseIds?: Set<string>;
  replacementStatus?: MessageReplacementStatus;
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

function SDKMessageRendererImpl({
  message,
  toolResultsMap,
  toolInputsMap,
  subagentMessagesMap,
  taskNotificationsMap,
  taskProgressMap,
  foldableToolUseIds,
  completedHookUuids,
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
  runningToolUseIds,
  replacementStatus,
  isLiveTail = false,
}: Props) {
  if (isHyperNeoActionMessage(message)) {
    const actionMsg = message as HyperNeoActionMessage;
    if (actionMsg.action === 'sdk_resume_choice') {
      return (
        <SDKResumeChoiceMessage message={actionMsg} sessionId={sessionId ?? actionMsg.session_id} />
      );
    }
    return null;
  }

  const sdkMessage = message as SDKMessage;

  if (!isUserVisibleMessage(sdkMessage) && !isRenderableSystemMessage(sdkMessage)) {
    return null;
  }

  if (isSDKSystemInit(sdkMessage)) {
    if (taskContext) {
      return <SystemInitPill message={sdkMessage as SystemInitMessage} />;
    }
    return null;
  }

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

  if (
    isSDKSystemMessage(sdkMessage) &&
    (sdkMessage as { subtype?: string }).subtype === 'task_notification'
  ) {
    const toolUseId = (sdkMessage as { tool_use_id?: string }).tool_use_id;
    if (toolUseId && foldableToolUseIds?.has(toolUseId)) {
      return null;
    }
  }

  let renderedMessage: JSX.Element | null = null;

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
        taskProgressMap={taskProgressMap}
        replacementStatusMap={replacementStatusMap}
        sessionId={sessionId}
        resolvedQuestions={resolvedQuestions}
        pendingQuestion={pendingQuestion}
        onQuestionResolved={onQuestionResolved}
        flattenSubagentTools={flattenSubagentTools}
        isRunning={isRunning}
        runningToolUseIds={runningToolUseIds}
      />
    );
  } else if (isSDKResultMessage(sdkMessage)) {
    renderedMessage = <SDKResultMessage message={sdkMessage} />;
  } else if (isSDKSystemMessage(sdkMessage)) {
    renderedMessage = (
      <SDKSystemMessage
        message={sdkMessage}
        isLiveTail={isLiveTail}
        completedHookUuids={completedHookUuids}
      />
    );
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
  } else if (isSDKPromptSuggestionMessage(sdkMessage)) {
    renderedMessage = <SDKPromptSuggestionMessage message={sdkMessage} />;
  } else if (isSDKToolUseSummaryMessage(sdkMessage)) {
    renderedMessage = <SDKToolUseSummaryMessage message={sdkMessage} />;
  } else {
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
    prev.taskProgressMap === next.taskProgressMap &&
    prev.foldableToolUseIds === next.foldableToolUseIds &&
    prev.completedHookUuids === next.completedHookUuids &&
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
    prev.runningToolUseIds === next.runningToolUseIds &&
    prev.replacementStatus === next.replacementStatus &&
    prev.isLiveTail === next.isLiveTail
  );
}

export const SDKMessageRenderer = memo(SDKMessageRendererImpl, areMessageRendererPropsEqual);
