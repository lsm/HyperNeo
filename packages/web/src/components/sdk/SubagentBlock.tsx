import type { ComponentChild } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import type { AgentInput } from '@hyperneo/shared/sdk/sdk-tools.d.ts';
import type {
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
} from '@hyperneo/shared/sdk/sdk.d.ts';
import {
  hasRenderableThinking,
  isHiddenSystemSubtype,
  isConditionallyHiddenSystemMessage,
  isTextBlock,
  isToolUseBlock,
  isThinkingBlock,
  type ContentBlock,
} from '@hyperneo/shared/sdk/type-guards';
import { TaskProgressLine } from './tools/TaskProgressLine.tsx';
import { ToolResultCard } from './tools/index.ts';
import { ThinkingBlock } from './ThinkingBlock.tsx';
import { SDKSystemMessage } from './SDKSystemMessage.tsx';
import {
  getMessageUuid,
  type MessageReplacementStatus,
} from '../../lib/sdk-message-replacement.ts';

function getUserMessageText(message: SDKMessage): string | null {
  if (message.type !== 'user') return null;

  const content = message.message?.content;
  if (!content) return null;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === 'text');
    return textBlock?.text || null;
  }

  return null;
}

function shouldHideNestedSystemMessage(message: SDKMessage, isLiveTail: boolean): boolean {
  if (message.type !== 'system') return false;
  const subtype = (message as { subtype?: string }).subtype;
  if (!subtype) return true;
  if (isHiddenSystemSubtype(subtype)) return true;
  if (isConditionallyHiddenSystemMessage(message)) return true;
  if (subtype === 'init') return true;
  if (subtype === 'informational' && (message as { level?: string }).level === 'info') return true;
  if (subtype === 'worker_shutting_down' && !isLiveTail) return true;
  return false;
}

function shouldUseSDKSystemRenderer(message: Extract<SDKMessage, { type: 'system' }>): boolean {
  const subtype = (message as { subtype?: string }).subtype;
  if (subtype === 'status') {
    return (message as { status?: string }).status === 'compacting';
  }
  return (
    subtype === 'compact_boundary' ||
    subtype === 'hook_response' ||
    subtype === 'hook_started' ||
    subtype === 'hook_progress' ||
    subtype === 'api_retry' ||
    subtype === 'session_state_changed' ||
    subtype === 'commands_changed' ||
    subtype === 'informational' ||
    subtype === 'worker_shutting_down' ||
    subtype === 'model_refusal_fallback' ||
    subtype === 'model_refusal_no_fallback' ||
    subtype === 'permission_denied' ||
    subtype === 'task_notification' ||
    subtype === 'memory_recall' ||
    subtype === 'local_command_output' ||
    subtype === 'notification' ||
    subtype === 'files_persisted' ||
    subtype === 'plugin_install'
  );
}

interface SubagentBlockProps {
  input: AgentInput;
  output?: unknown;
  isError?: boolean;
  toolId: string;
  nestedMessages?: SDKMessage[];
  toolResultsMap?: Map<string, unknown>;
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  taskNotification?: {
    status: 'completed' | 'failed' | 'stopped';
    summary?: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  };
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  taskProgress?: SDKTaskProgressMessage;
  taskProgressMap?: Map<string, SDKTaskProgressMessage>;
  className?: string;
  isRunning?: boolean;
}

function getSubagentIcon(subagentType: string) {
  const iconClass = 'w-5 h-5 flex-shrink-0';

  switch (subagentType.toLowerCase()) {
    case 'explore':
      return (
        <svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      );
    case 'plan':
      return (
        <svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
          />
        </svg>
      );
    case 'general-purpose':
      return (
        <svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
          />
        </svg>
      );
    case 'claude-code-guide':
      return (
        <svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
          />
        </svg>
      );
    default:
      return (
        <svg class={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
          />
        </svg>
      );
  }
}

function getSubagentColors(subagentType: string) {
  switch (subagentType.toLowerCase()) {
    case 'explore':
      return {
        bg: 'bg-cat-cyan/10',
        border: 'border-cat-cyan/40',
        text: 'text-cat-cyan',
        badge: 'bg-cyan-100 dark:bg-cyan-800/50 text-cat-cyan',
        icon: 'text-cat-cyan',
      };
    case 'plan':
      return {
        bg: 'bg-cat-violet/10',
        border: 'border-cat-violet/40',
        text: 'text-cat-violet',
        badge: 'bg-violet-100 dark:bg-violet-800/50 text-cat-violet',
        icon: 'text-cat-violet',
      };
    case 'claude-code-guide':
      return {
        bg: 'bg-warning/10',
        border: 'border-warning/40',
        text: 'text-warning-soft',
        badge: 'bg-warning/15 dark:bg-amber-800/50 text-warning-soft',
        icon: 'text-warning',
      };
    default:
      return {
        bg: 'bg-cat-indigo/10',
        border: 'border-cat-indigo/40',
        text: 'text-cat-indigo',
        badge: 'bg-indigo-100 dark:bg-indigo-800/50 text-cat-indigo',
        icon: 'text-cat-indigo',
      };
  }
}

function extractOutputText(output: unknown): string {
  if (!output) return '';

  if (typeof output === 'string') {
    return output;
  }

  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;

    if ('content' in obj) {
      const content = obj.content;

      if (typeof content === 'string') {
        return content;
      }

      if (Array.isArray(content)) {
        return content
          .map((block) => {
            if (typeof block === 'string') {
              return block;
            }
            if (typeof block === 'object' && block !== null) {
              const blockObj = block as Record<string, unknown>;
              if ('text' in blockObj && typeof blockObj.text === 'string') {
                return blockObj.text;
              }
              if ('content' in blockObj && typeof blockObj.content === 'string') {
                return blockObj.content;
              }
            }
            return '';
          })
          .filter(Boolean)
          .join('\n\n');
      }
    }

    if ('text' in obj && typeof obj.text === 'string') {
      return obj.text;
    }

    if ('result' in obj && typeof obj.result === 'string') {
      return obj.result;
    }

    return JSON.stringify(output, null, 2);
  }

  return String(output);
}

export function SubagentBlock({
  input,
  output,
  isError = false,
  toolId: _toolId,
  nestedMessages = [],
  toolResultsMap,
  replacementStatusMap,
  taskNotification,
  taskNotificationsMap,
  taskProgress,
  taskProgressMap,
  className,
  isRunning = false,
}: SubagentBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const colors = getSubagentColors(input.subagent_type ?? 'general-purpose');
  const outputText = extractOutputText(output);
  const taskStatus = taskNotification?.status;
  const notificationIsError = taskStatus === 'failed' || taskStatus === 'stopped';
  const notificationIsSuccess = taskStatus === 'completed';
  const showErrorIcon = notificationIsError || (!taskNotification && isError);

  const filteredNestedMessages = useMemo(() => {
    if (nestedMessages.length === 0) return [];

    const nestedToolUseIds = new Set<string>();
    for (const msg of nestedMessages) {
      if (msg.type !== 'assistant' || !Array.isArray(msg.message.content)) continue;
      for (const block of msg.message.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string') nestedToolUseIds.add(b.id);
      }
    }

    return nestedMessages.filter((msg, idx) => {
      if (shouldHideNestedSystemMessage(msg, idx === nestedMessages.length - 1)) {
        return false;
      }

      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'task_notification') {
        const toolUseId = (msg as { tool_use_id?: string }).tool_use_id;
        if (toolUseId && nestedToolUseIds.has(toolUseId)) return false;
      }

      if (idx !== 0) return true;

      if (msg.type !== 'user') return true;

      const msgText = getUserMessageText(msg);
      if (msgText && msgText === input.prompt) {
        return false;
      }

      return true;
    });
  }, [nestedMessages, input.prompt]);

  const nestedCompletedHookUuids = useMemo(() => {
    const completed = new Set<string>();
    const pendingByHook = new Map<string, string[]>();
    for (const msg of nestedMessages) {
      if (msg.type === 'result') {
        pendingByHook.clear();
        continue;
      }
      if (msg.type !== 'system') continue;
      const sub = (msg as { subtype?: string }).subtype;
      const hookId = (msg as { hook_id?: string }).hook_id;
      if (!hookId) continue;
      if (sub === 'hook_started' || sub === 'hook_progress') {
        const uuid = (msg as { uuid?: string }).uuid;
        if (uuid) {
          const list = pendingByHook.get(hookId);
          if (list) list.push(uuid);
          else pendingByHook.set(hookId, [uuid]);
        }
      } else if (sub === 'hook_response') {
        for (const uuid of pendingByHook.get(hookId) ?? []) completed.add(uuid);
        pendingByHook.delete(hookId);
      }
    }
    return completed;
  }, [nestedMessages]);

  const block = (
    <div
      class={cn(
        'border rounded-lg overflow-hidden',
        isRunning && 'relative',
        colors.bg,
        colors.border,
        className
      )}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        class={cn(
          'w-full flex items-center justify-between p-3 transition-colors',
          'hover:bg-opacity-80 dark:hover:bg-opacity-80'
        )}
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class={colors.icon}>
            {getSubagentIcon(input.subagent_type ?? 'general-purpose')}
          </span>

          <span
            class={cn('text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0', colors.badge)}
          >
            {input.subagent_type ?? 'general-purpose'}
          </span>

          <span class={cn('text-sm font-medium truncate', colors.text)}>{input.description}</span>
        </div>

        <div class="flex items-center gap-2 flex-shrink-0">
          {filteredNestedMessages.length > 0 && (
            <span class="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-fill-strong text-fg-soft">
              {filteredNestedMessages.length}
            </span>
          )}
          {notificationIsSuccess && (
            <svg class="w-4 h-4 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
          {showErrorIcon && (
            <svg class="w-4 h-4 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          )}
          <svg
            class={cn('w-5 h-5 transition-transform', colors.icon, isExpanded ? 'rotate-180' : '')}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {isRunning && taskProgress && <TaskProgressLine progress={taskProgress} />}

      {isExpanded && (
        <div class={cn('border-t bg-surface', colors.border)}>
          {taskNotification && (taskNotification.summary || taskNotification.usage) && (
            <div class="border-b border-line p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {taskNotification.summary && (
                <span
                  class={cn(
                    'font-medium',
                    notificationIsSuccess
                      ? 'text-success-soft'
                      : notificationIsError
                        ? 'text-danger-soft'
                        : 'text-fg-soft'
                  )}
                >
                  {taskNotification.summary}
                </span>
              )}
              {taskNotification.usage && (
                <span class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-fg-muted">
                  <span>{taskNotification.usage.total_tokens.toLocaleString()} tokens</span>
                  <span>{taskNotification.usage.tool_uses} tool uses</span>
                  <span>{(taskNotification.usage.duration_ms / 1000).toFixed(1)}s</span>
                </span>
              )}
            </div>
          )}
          <div class="border-b border-line p-3">
            <div class="text-xs font-semibold text-fg-muted mb-2">Input</div>
            <div class="text-sm bg-surface-raised p-3 rounded border border-line whitespace-pre-wrap break-words text-fg-soft">
              {input.prompt}
            </div>
          </div>

          {filteredNestedMessages.length > 0 && (
            <div class="border-b border-line p-3">
              <div class="text-xs font-semibold text-fg-muted mb-2">
                Messages ({filteredNestedMessages.length})
              </div>
              <div class="space-y-3">
                {filteredNestedMessages.map((msg, idx) => (
                  <NestedMessageRenderer
                    key={msg.uuid || `nested-${idx}`}
                    message={msg}
                    isLiveTail={idx === filteredNestedMessages.length - 1}
                    toolResultsMap={toolResultsMap}
                    replacementStatusMap={replacementStatusMap}
                    taskNotificationsMap={taskNotificationsMap}
                    taskProgressMap={taskProgressMap}
                    isParentRunning={isRunning}
                    completedHookUuids={nestedCompletedHookUuids}
                  />
                ))}
              </div>
            </div>
          )}

          <div class="p-3">
            <div class="text-xs font-semibold text-fg-muted mb-2">Output</div>
            {outputText ? (
              <div
                class={cn(
                  'bg-surface-raised p-3 rounded border border-line',
                  'prose prose-sm dark:prose-invert max-w-full overflow-x-auto',
                  'prose-pre:bg-surface prose-pre:text-fg',
                  isError && 'text-danger'
                )}
              >
                <MarkdownRenderer content={outputText} />
              </div>
            ) : (
              <div class="text-sm bg-surface-raised p-3 rounded border border-line text-fg-muted italic">
                No output yet...
              </div>
            )}
          </div>
        </div>
      )}
      {isRunning && <div class="running-shimmer" aria-hidden="true" />}
    </div>
  );

  return block;
}

function NestedMessageRenderer({
  message,
  isLiveTail,
  toolResultsMap,
  replacementStatusMap,
  taskNotificationsMap,
  taskProgressMap,
  isParentRunning,
  completedHookUuids,
}: {
  message: SDKMessage;
  isLiveTail: boolean;
  toolResultsMap?: Map<string, unknown>;
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  taskProgressMap?: Map<string, SDKTaskProgressMessage>;
  isParentRunning?: boolean;
  completedHookUuids?: Set<string>;
}) {
  const replacementStatus = replacementStatusMap?.get(getMessageUuid(message) ?? '');
  const withReplacementStatus = (content: ComponentChild) => {
    if (!replacementStatus || content == null || content === false) return content;
    const isRetracted = replacementStatus === 'retracted';
    return (
      <div
        class={`rounded-lg border px-2 py-1 ${
          isRetracted ? 'border-rose-500/35 bg-rose-500/5' : 'border-warning/35 bg-warning/5'
        }`}
        data-message-replacement-status={replacementStatus}
      >
        <div
          class={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
            isRetracted ? 'text-cat-rose' : 'text-warning'
          }`}
        >
          {isRetracted ? 'Retracted by fallback' : 'Superseded by replacement'}
        </div>
        <div class="opacity-80">{content}</div>
      </div>
    );
  };

  if (message.type === 'assistant') {
    const apiMessage = message.message;
    const content = apiMessage.content as ContentBlock[];

    const estimatedThinkingTokens = (message as { estimated_thinking_tokens?: number })
      .estimated_thinking_tokens;

    const textBlocks = content.filter((block) => isTextBlock(block));
    const toolBlocks = content.filter((block) => isToolUseBlock(block));
    const thinkingBlocks = content
      .filter((block) => isThinkingBlock(block))
      .filter((block) => hasRenderableThinking(block));

    return withReplacementStatus(
      <div class="space-y-2">
        {thinkingBlocks.map((block, idx) => (
          <ThinkingBlock
            key={`thinking-${idx}`}
            content={(block as { thinking: string }).thinking}
            estimatedTokens={estimatedThinkingTokens}
          />
        ))}

        {toolBlocks.map((block, idx) => {
          const toolBlock = block as {
            type: 'tool_use';
            id: string;
            name: string;
            input: unknown;
          };
          const resultData = toolResultsMap?.get(toolBlock.id) as
            | { content: unknown; isOutputRemoved?: boolean }
            | undefined;
          const taskNotification = taskNotificationsMap?.get(toolBlock.id);
          const taskProgress = taskProgressMap?.get(toolBlock.id);
          const isRunningTool = !!isParentRunning && !!taskProgress && !taskNotification;
          return (
            <ToolResultCard
              key={`tool-${idx}`}
              toolName={toolBlock.name}
              toolId={toolBlock.id}
              input={toolBlock.input}
              output={resultData?.content}
              isError={
                ((resultData?.content as Record<string, unknown>)?.is_error as boolean) || false
              }
              variant="default"
              isOutputRemoved={resultData?.isOutputRemoved || false}
              taskNotification={taskNotification}
              taskProgress={taskProgress}
              isRunning={isRunningTool}
            />
          );
        })}

        {textBlocks.length > 0 && (
          <div class="bg-surface-raised p-3 rounded border border-line overflow-x-auto">
            {textBlocks.map((block, idx) => (
              <div key={idx} class="prose prose-sm dark:prose-invert max-w-full">
                <MarkdownRenderer content={(block as { text: string }).text} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (message.type === 'user') {
    const apiMessage = message.message;
    const content = apiMessage.content;

    if (Array.isArray(content)) {
      const hasNonToolResultContent = content.some((block) => {
        const blockObj = block as unknown as Record<string, unknown>;
        return blockObj.type !== 'tool_result';
      });

      if (!hasNonToolResultContent) {
        return null;
      }

      return withReplacementStatus(
        <div class="bg-accent/10 p-3 rounded border border-accent/40">
          {content.map((block, idx) => {
            const blockObj = block as unknown as Record<string, unknown>;
            if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
              return (
                <div key={idx} class="text-sm text-accent-soft whitespace-pre-wrap break-words">
                  {blockObj.text}
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }

    if (typeof content === 'string') {
      return withReplacementStatus(
        <div class="bg-accent/10 p-3 rounded border border-accent/40 text-sm text-accent-soft whitespace-pre-wrap break-words">
          {content}
        </div>
      );
    }

    return null;
  }

  if (message.type === 'result') {
    const resultMessage = message as SDKMessage & {
      subtype: string;
      result?: string;
      is_error?: boolean;
    };

    if (resultMessage.result) {
      return withReplacementStatus(
        <div
          class={cn(
            'bg-surface-raised p-3 rounded border',
            resultMessage.is_error ? 'border-danger/40 text-danger' : 'border-line text-fg-soft'
          )}
        >
          <div class="text-xs font-semibold mb-1">Result</div>
          <pre class="text-sm whitespace-pre-wrap break-words overflow-x-auto">
            {resultMessage.result}
          </pre>
        </div>
      );
    }
    return null;
  }

  if (message.type === 'system') {
    const systemMessage = message as Extract<SDKMessage, { type: 'system' }>;
    if (shouldUseSDKSystemRenderer(systemMessage)) {
      return withReplacementStatus(
        <SDKSystemMessage
          message={systemMessage}
          isLiveTail={isLiveTail}
          completedHookUuids={completedHookUuids}
        />
      );
    }
    return withReplacementStatus(
      <div class="bg-surface-raised p-2 rounded text-xs text-fg-soft">
        System: {(systemMessage as { subtype?: string }).subtype ?? 'message'}
      </div>
    );
  }

  return withReplacementStatus(
    <div class="bg-surface-raised p-2 rounded text-xs">
      <details>
        <summary class="cursor-pointer text-fg-faint">Unknown message type: {message.type}</summary>
        <pre class="mt-2 overflow-x-auto">{JSON.stringify(message, null, 2)}</pre>
      </details>
    </div>
  );
}
