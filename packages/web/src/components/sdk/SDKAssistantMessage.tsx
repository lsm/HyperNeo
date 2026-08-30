import type {
  PendingUserQuestion,
  QuestionDraftResponse,
  ResolvedQuestion,
} from '@hyperneo/shared';
import type {
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
} from '@hyperneo/shared/sdk/sdk.d.ts';
import type { AgentInput } from '@hyperneo/shared/sdk/sdk-tools.d.ts';
import {
  type ContentBlock,
  hasRenderableThinking,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
} from '@hyperneo/shared/sdk/type-guards';
import { useEffect, useState } from 'preact/hooks';
import { toast } from '../../lib/toast.ts';
import { cn, copyToClipboard } from '../../lib/utils.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import { QuestionPrompt } from '../QuestionPrompt.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';
import { SubagentBlock } from './SubagentBlock.tsx';
import { ThinkingBlock } from './ThinkingBlock.tsx';
import { ToolResultCard } from './tools/index.ts';
import type { MessageReplacementStatus } from '../../lib/sdk-message-replacement.ts';

type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;

interface Props {
  message: AssistantMessage;
  toolResultsMap?: Map<string, unknown>;
  subagentMessagesMap?: Map<string, SDKMessage[]>;
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  taskProgressMap?: Map<string, SDKTaskProgressMessage>;
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  sessionId?: string;
  resolvedQuestions?: Map<string, ResolvedQuestion>;
  pendingQuestion?: PendingUserQuestion | null;
  onQuestionResolved?: (
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[]
  ) => void;
  isRunning?: boolean;
  runningToolUseIds?: Set<string>;
  flattenSubagentTools?: boolean;
}

export function SDKAssistantMessage({
  message,
  toolResultsMap,
  subagentMessagesMap,
  taskNotificationsMap,
  taskProgressMap,
  replacementStatusMap,
  sessionId,
  resolvedQuestions,
  pendingQuestion,
  onQuestionResolved,
  isRunning,
  runningToolUseIds,
  flattenSubagentTools = false,
}: Props) {
  const { message: apiMessage } = message;
  const contentBlocks = apiMessage.content as ContentBlock[];
  const hasError = 'error' in message && message.error !== undefined;

  const getTextContent = (): string => {
    return contentBlocks
      .map((block: ContentBlock) => {
        if (isTextBlock(block)) {
          return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  };

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    const textContent = getTextContent();
    const success = await copyToClipboard(textContent);
    if (success) {
      setCopied(true);
    } else {
      toast.error('Failed to copy message');
    }
  };

  const getTimestamp = (): string => {
    const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
    const date = messageWithTimestamp.timestamp
      ? new Date(messageWithTimestamp.timestamp)
      : new Date();
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getFullTimestamp = (): string => {
    const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
    const date = messageWithTimestamp.timestamp
      ? new Date(messageWithTimestamp.timestamp)
      : new Date();
    return date.toLocaleString();
  };

  const textBlocks = contentBlocks.filter(isTextBlock);
  const toolBlocks = contentBlocks.filter(isToolUseBlock);
  const thinkingBlocks = contentBlocks.filter(isThinkingBlock).filter(hasRenderableThinking);

  const estimatedThinkingTokens = (message as Record<string, unknown>).estimated_thinking_tokens as
    | number
    | undefined;

  const messageWithTimestamp = message as SDKMessage & { timestamp?: number };

  const textBlockBubble =
    textBlocks.length > 0 ? (
      <div
        class={cn(
          hasError ? 'bg-danger/10 border border-danger/40' : 'bg-surface-raised',
          'rounded-[20px]',
          'px-3 py-1.5 md:px-3.5 md:py-2',
          'space-y-3'
        )}
      >
        {hasError && (
          <div class="flex items-center gap-2 text-danger text-sm font-medium">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span>API Error</span>
          </div>
        )}
        {textBlocks.map((block: Extract<ContentBlock, { type: 'text' }>, idx: number) => (
          <div key={idx} class={hasError ? 'text-danger-soft' : 'text-accent-fg'}>
            <MarkdownRenderer
              content={block.text}
              class="dark:prose-invert prose-pre:bg-surface prose-pre:text-fg"
            />
          </div>
        ))}

        {message.parent_tool_use_id && (
          <div class="text-xs text-fg-muted italic">
            Sub-agent response (parent: {message.parent_tool_use_id.slice(0, 8)}...)
          </div>
        )}
      </div>
    ) : null;

  const textBlockActions =
    textBlocks.length > 0 ? (
      <div class="flex items-center gap-2 mt-2 px-1">
        <Tooltip content={getFullTimestamp()} position="right">
          <span class="text-xs text-fg-faint">{getTimestamp()}</span>
        </Tooltip>

        <IconButton
          size="md"
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy message'}
          class={copied ? 'text-success' : ''}
        >
          {copied ? (
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          ) : (
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </IconButton>
      </div>
    ) : null;

  const messageContent = (
    <div
      class="py-2 space-y-3"
      data-testid="assistant-message"
      data-message-role="assistant"
      data-message-uuid={message.uuid}
      data-message-timestamp={messageWithTimestamp.timestamp || 0}
    >
      {toolBlocks.map((block: Extract<ContentBlock, { type: 'tool_use' }>, idx: number) => {
        const toolResult = toolResultsMap?.get(block.id);
        const nestedMessages = subagentMessagesMap?.get(block.id) || [];
        const taskNotification = taskNotificationsMap?.get(block.id);
        const taskProgress = taskProgressMap?.get(block.id);
        return (
          <ToolUseBlock
            key={`tool-${idx}`}
            block={block}
            toolResult={toolResult}
            nestedMessages={nestedMessages}
            toolResultsMap={toolResultsMap}
            replacementStatusMap={replacementStatusMap}
            taskNotification={taskNotification}
            taskNotificationsMap={taskNotificationsMap}
            taskProgress={taskProgress}
            taskProgressMap={taskProgressMap}
            sessionId={sessionId}
            resolvedQuestions={resolvedQuestions}
            pendingQuestion={pendingQuestion}
            onQuestionResolved={onQuestionResolved}
            flattenSubagentTools={flattenSubagentTools}
            isRunning={!!isRunning || runningToolUseIds?.has(block.id)}
          />
        );
      })}

      {thinkingBlocks.map((block: Extract<ContentBlock, { type: 'thinking' }>, idx: number) => (
        <ThinkingBlock
          key={`thinking-${idx}`}
          content={block.thinking}
          isRunning={!!isRunning}
          estimatedTokens={estimatedThinkingTokens}
        />
      ))}

      {textBlockBubble && (
        <div class="w-full space-y-3">
          {textBlockBubble}
          {textBlockActions}
        </div>
      )}
    </div>
  );

  return messageContent;
}

function ToolUseBlock({
  block,
  toolResult,
  nestedMessages,
  toolResultsMap,
  replacementStatusMap,
  taskNotification,
  taskNotificationsMap,
  taskProgress,
  taskProgressMap,
  sessionId: propSessionId,
  resolvedQuestions,
  pendingQuestion,
  onQuestionResolved,
  isRunning,
  flattenSubagentTools = false,
}: {
  block: Extract<ContentBlock, { type: 'tool_use' }>;
  toolResult?: unknown;
  nestedMessages?: SDKMessage[];
  toolResultsMap?: Map<string, unknown>;
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  taskNotification?: SDKTaskNotificationMessage;
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  taskProgress?: SDKTaskProgressMessage;
  taskProgressMap?: Map<string, SDKTaskProgressMessage>;
  sessionId?: string;
  resolvedQuestions?: Map<string, ResolvedQuestion>;
  pendingQuestion?: PendingUserQuestion | null;
  onQuestionResolved?: (
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[]
  ) => void;
  isRunning?: boolean;
  flattenSubagentTools?: boolean;
}) {
  const resultData = toolResult as
    | {
        content: unknown;
        messageUuid?: string;
        sessionId?: string;
        isOutputRemoved?: boolean;
      }
    | undefined;
  const content = resultData?.content;
  const messageUuid = resultData?.messageUuid;
  const sessionId = resultData?.sessionId || propSessionId;
  const isOutputRemoved = resultData?.isOutputRemoved || false;

  if (!flattenSubagentTools && (block.name === 'Task' || block.name === 'Agent')) {
    return (
      <SubagentBlock
        input={block.input as unknown as AgentInput}
        output={content}
        isError={((content as Record<string, unknown>)?.is_error as boolean) || false}
        toolId={block.id}
        nestedMessages={nestedMessages}
        toolResultsMap={toolResultsMap}
        replacementStatusMap={replacementStatusMap}
        taskNotification={taskNotification}
        taskNotificationsMap={taskNotificationsMap}
        taskProgress={taskProgress}
        taskProgressMap={taskProgressMap}
        isRunning={isRunning}
      />
    );
  }

  if (block.name === 'AskUserQuestion' && sessionId) {
    const toolUseId = block.id;
    const resolved = resolvedQuestions?.get(toolUseId);
    const isPending = pendingQuestion?.toolUseId === toolUseId;

    const getQuestionData = (): PendingUserQuestion | null => {
      if (resolved) return resolved.question;
      if (isPending && pendingQuestion) return pendingQuestion;

      const input = block.input as Record<string, unknown>;
      if (input && typeof input === 'object' && 'questions' in input) {
        const questions = input.questions as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        if (Array.isArray(questions)) {
          return {
            toolUseId,
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: Array.isArray(q.options) ? q.options : [],
              multiSelect: q.multiSelect,
            })),
            askedAt: Date.now(),
          };
        }
      }
      return null;
    };

    const questionData = getQuestionData();
    if (!questionData) {
      return (
        <div>
          <ToolResultCard
            toolName={block.name}
            toolId={block.id}
            input={block.input}
            output={content}
            isError={((content as Record<string, unknown>)?.is_error as boolean) || false}
            variant="default"
            messageUuid={messageUuid}
            sessionId={sessionId}
            isOutputRemoved={isOutputRemoved}
            taskNotification={taskNotification}
            taskProgress={taskProgress}
            isRunning={isRunning}
          />
        </div>
      );
    }

    return (
      <div>
        <ToolResultCard
          toolName={block.name}
          toolId={block.id}
          input={block.input}
          output={content}
          isError={((content as Record<string, unknown>)?.is_error as boolean) || false}
          variant="default"
          messageUuid={messageUuid}
          sessionId={sessionId}
          isOutputRemoved={isOutputRemoved}
          taskNotification={taskNotification}
          taskProgress={taskProgress}
          isRunning={isRunning}
        />
        {resolved ? (
          <QuestionPrompt
            sessionId={sessionId}
            pendingQuestion={resolved.question}
            resolvedState={resolved.state}
            finalResponses={resolved.responses}
            cancelReason={resolved.cancelReason}
          />
        ) : isPending ? (
          <QuestionPrompt
            sessionId={sessionId}
            pendingQuestion={pendingQuestion!}
            onResolved={onQuestionResolved}
          />
        ) : (
          <QuestionPrompt
            sessionId={sessionId}
            pendingQuestion={questionData}
            resolvedState={'cancelled'}
            finalResponses={[]}
          />
        )}
      </div>
    );
  }

  return (
    <ToolResultCard
      toolName={block.name}
      toolId={block.id}
      input={block.input}
      output={content}
      isError={((content as Record<string, unknown>)?.is_error as boolean) || false}
      variant="default"
      messageUuid={messageUuid}
      sessionId={sessionId}
      isOutputRemoved={isOutputRemoved}
      taskNotification={taskNotification}
      taskProgress={taskProgress}
      isRunning={isRunning}
    />
  );
}
