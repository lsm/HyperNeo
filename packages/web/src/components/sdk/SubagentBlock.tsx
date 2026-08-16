/**
 * SubagentBlock Component - Displays sub-agent task execution with input/output
 *
 * Renders Task tool calls as a distinct block instead of a generic tool card,
 * showing:
 * - Header: [icon] [subagent_type] [description]
 * - Input: The prompt sent to the sub-agent
 * - Messages: All nested messages from the sub-agent execution
 * - Output: The sub-agent's final response (markdown rendered)
 */

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

/**
 * Extract text content from a user message for comparison with input prompt
 */
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
  // Honor the centralized hidden-subtype contract so nested timelines
  // don't leak noise rows the main transcript already hides.
  if (isHiddenSystemSubtype(subtype)) return true;
  // Honor conditional hides so success-noise rows don't leak either.
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
  /** The Task tool input containing subagent_type, description, prompt */
  input: AgentInput;
  /** The tool result (sub-agent's final response) */
  output?: unknown;
  /** Whether this is an error result */
  isError?: boolean;
  /** The tool use ID */
  toolId: string;
  /** All messages from the sub-agent execution */
  nestedMessages?: SDKMessage[];
  /** Map of tool use IDs to their results (for nested tool calls) */
  toolResultsMap?: Map<string, unknown>;
  /** Map of SDK message UUIDs to replacement/retraction status. */
  replacementStatusMap?: Map<string, MessageReplacementStatus>;
  /** Terminal task_notification for this Task/Agent tool_use (status/summary/usage),
   * folded onto the header instead of a standalone system row. */
  taskNotification?: {
    status: 'completed' | 'failed' | 'stopped';
    summary?: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  };
  /** Full tool_use_id → task_notification map, so nested tool_use blocks inside
   * this subagent can fold their own terminal status onto their ToolResultCard
   * (the top-level suppression relies on toolInputsMap having the nested id, so
   * the nested card must actually receive the notification). */
  taskNotificationsMap?: Map<string, SDKTaskNotificationMessage>;
  /** Latest live task_progress for this Task/Agent tool_use. */
  taskProgress?: SDKTaskProgressMessage;
  /** Full tool_use_id → task_progress map for nested tool_use blocks. */
  taskProgressMap?: Map<string, SDKTaskProgressMessage>;
  /** Additional CSS classes */
  className?: string;
  /** When true, show a faint white shimmer sweep (the `.running-shimmer`
   * overlay) across this block's surface. */
  isRunning?: boolean;
}

/**
 * Get icon for subagent type
 */
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
      // Default agent icon
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

/**
 * Get color scheme for subagent type
 */
function getSubagentColors(subagentType: string) {
  switch (subagentType.toLowerCase()) {
    case 'explore':
      return {
        bg: 'bg-cyan-50 dark:bg-cyan-900/20',
        border: 'border-cyan-200 dark:border-cyan-800',
        text: 'text-cyan-700 dark:text-cyan-300',
        badge: 'bg-cyan-100 dark:bg-cyan-800/50 text-cyan-700 dark:text-cyan-300',
        icon: 'text-cyan-600 dark:text-cyan-400',
      };
    case 'plan':
      return {
        bg: 'bg-violet-50 dark:bg-violet-900/20',
        border: 'border-violet-200 dark:border-violet-800',
        text: 'text-violet-700 dark:text-violet-300',
        badge: 'bg-violet-100 dark:bg-violet-800/50 text-violet-700 dark:text-violet-300',
        icon: 'text-violet-600 dark:text-violet-400',
      };
    case 'claude-code-guide':
      return {
        bg: 'bg-amber-50 dark:bg-amber-900/20',
        border: 'border-amber-200 dark:border-amber-800',
        text: 'text-amber-700 dark:text-amber-300',
        badge: 'bg-amber-100 dark:bg-amber-800/50 text-amber-700 dark:text-amber-300',
        icon: 'text-amber-600 dark:text-amber-400',
      };
    default:
      return {
        bg: 'bg-indigo-50 dark:bg-indigo-900/20',
        border: 'border-indigo-200 dark:border-indigo-800',
        text: 'text-indigo-700 dark:text-indigo-300',
        badge: 'bg-indigo-100 dark:bg-indigo-800/50 text-indigo-700 dark:text-indigo-300',
        icon: 'text-indigo-600 dark:text-indigo-400',
      };
  }
}

/**
 * Extract text content from output
 */
function extractOutputText(output: unknown): string {
  if (!output) return '';

  if (typeof output === 'string') {
    return output;
  }

  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;

    // Check for content field (common in tool results)
    if ('content' in obj) {
      const content = obj.content;

      // Handle string content
      if (typeof content === 'string') {
        return content;
      }

      // Handle array of content blocks (Claude API format)
      if (Array.isArray(content)) {
        return content
          .map((block) => {
            if (typeof block === 'string') {
              return block;
            }
            if (typeof block === 'object' && block !== null) {
              const blockObj = block as Record<string, unknown>;
              // Extract text from content blocks like {type: "text", text: "..."}
              if ('text' in blockObj && typeof blockObj.text === 'string') {
                return blockObj.text;
              }
              // Handle other block types that might have content
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

    // Check for text field
    if ('text' in obj && typeof obj.text === 'string') {
      return obj.text;
    }

    // Check for result field
    if ('result' in obj && typeof obj.result === 'string') {
      return obj.result;
    }

    // Fallback to JSON
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
  // task_notification is authoritative when present; otherwise fall back to isError.
  const taskStatus = taskNotification?.status;
  const notificationIsError = taskStatus === 'failed' || taskStatus === 'stopped';
  const notificationIsSuccess = taskStatus === 'completed';
  const showErrorIcon = notificationIsError || (!taskNotification && isError);

  /**
   * Filter out the first user message that duplicates the input prompt.
   *
   * When the SDK invokes a Task tool (sub-agent), it creates an initial user message
   * containing the prompt text. This is redundant since we already show the input
   * in the "Input" section, so we filter it out to avoid showing the same content twice.
   */
  const filteredNestedMessages = useMemo(() => {
    if (nestedMessages.length === 0) return [];

    // Nested tool_use ids — their task_notification is folded onto the nested
    // ToolResultCard (via taskNotificationsMap), so a standalone
    // task_notification row for one of these would duplicate the folded status
    // on expand. Suppress those; orphan notifications (no tool_use_id, or a
    // tool_use not present in this timeline) are still rendered.
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

      // Suppress a folded nested task_notification: its tool_use card already
      // shows the status, so a standalone row would duplicate it.
      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'task_notification') {
        const toolUseId = (msg as { tool_use_id?: string }).tool_use_id;
        if (toolUseId && nestedToolUseIds.has(toolUseId)) return false;
      }

      // Only check the first message
      if (idx !== 0) return true;

      // Only filter user messages
      if (msg.type !== 'user') return true;

      // Check if the message content matches the input prompt
      const msgText = getUserMessageText(msg);
      if (msgText && msgText === input.prompt) {
        return false; // Filter out this duplicate
      }

      return true;
    });
  }, [nestedMessages, input.prompt]);

  // UUIDs of hook_started/hook_progress phases in this subagent's slice whose
  // run reached hook_response in the SAME turn (a result message closes the
  // turn). Turn-scoped because hook_id is only unique within a turn — matches
  // the top-level useMessageMaps.completedHookUuids contract.
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

  // The running-state shimmer is a `.running-shimmer` overlay rendered inside
  // this card while isRunning (added below). overflow-hidden contains it to
  // the card's rounded surface.
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
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        class={cn(
          'w-full flex items-center justify-between p-3 transition-colors',
          'hover:bg-opacity-80 dark:hover:bg-opacity-80'
        )}
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          {/* Icon */}
          <span class={colors.icon}>
            {getSubagentIcon(input.subagent_type ?? 'general-purpose')}
          </span>

          {/* Subagent type badge */}
          <span
            class={cn('text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0', colors.badge)}
          >
            {input.subagent_type ?? 'general-purpose'}
          </span>

          {/* Description */}
          <span class={cn('text-sm font-medium truncate', colors.text)}>{input.description}</span>
        </div>

        <div class="flex items-center gap-2 flex-shrink-0">
          {/* Message counter */}
          {filteredNestedMessages.length > 0 && (
            <span class="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              {filteredNestedMessages.length}
            </span>
          )}
          {notificationIsSuccess && (
            <svg
              class="w-4 h-4 text-green-600 dark:text-green-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
          {showErrorIcon && (
            <svg
              class="w-4 h-4 text-red-600 dark:text-red-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
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

      {/* Expanded content */}
      {isExpanded && (
        <div class={cn('border-t bg-white dark:bg-gray-900', colors.border)}>
          {/* Folded task_notification summary + usage. */}
          {taskNotification && (taskNotification.summary || taskNotification.usage) && (
            <div class="border-b border-gray-200 dark:border-gray-700 p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {taskNotification.summary && (
                <span
                  class={cn(
                    'font-medium',
                    notificationIsSuccess
                      ? 'text-green-700 dark:text-green-300'
                      : notificationIsError
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-gray-600 dark:text-gray-300'
                  )}
                >
                  {taskNotification.summary}
                </span>
              )}
              {taskNotification.usage && (
                <span class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-gray-500 dark:text-gray-400">
                  <span>{taskNotification.usage.total_tokens.toLocaleString()} tokens</span>
                  <span>{taskNotification.usage.tool_uses} tool uses</span>
                  <span>{(taskNotification.usage.duration_ms / 1000).toFixed(1)}s</span>
                </span>
              )}
            </div>
          )}
          {/* Input section */}
          <div class="border-b border-gray-200 dark:border-gray-700 p-3">
            <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Input</div>
            <div class="text-sm bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
              {input.prompt}
            </div>
          </div>

          {/* Nested messages section */}
          {filteredNestedMessages.length > 0 && (
            <div class="border-b border-gray-200 dark:border-gray-700 p-3">
              <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
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

          {/* Output section */}
          <div class="p-3">
            <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Output</div>
            {outputText ? (
              <div
                class={cn(
                  'bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700',
                  'prose prose-sm dark:prose-invert max-w-full overflow-x-auto',
                  'prose-pre:bg-gray-900 prose-pre:text-gray-100',
                  isError && 'text-red-600 dark:text-red-400'
                )}
              >
                <MarkdownRenderer content={outputText} />
              </div>
            ) : (
              <div class="text-sm bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 italic">
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

/**
 * Renders a single nested message from the sub-agent execution
 */
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
          isRetracted ? 'border-rose-500/35 bg-rose-500/5' : 'border-amber-500/35 bg-amber-500/5'
        }`}
        data-message-replacement-status={replacementStatus}
      >
        <div
          class={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
            isRetracted ? 'text-rose-300' : 'text-amber-300'
          }`}
        >
          {isRetracted ? 'Retracted by fallback' : 'Superseded by replacement'}
        </div>
        <div class="opacity-80">{content}</div>
      </div>
    );
  };

  // Handle assistant messages
  if (message.type === 'assistant') {
    const apiMessage = message.message;
    const content = apiMessage.content as ContentBlock[];

    // Extract estimated thinking tokens if present (stamped by daemon handler on SDK wrapper)
    const estimatedThinkingTokens = (message as { estimated_thinking_tokens?: number })
      .estimated_thinking_tokens;

    const textBlocks = content.filter((block) => isTextBlock(block));
    const toolBlocks = content.filter((block) => isToolUseBlock(block));
    // Filter out Opus 4.7 "omitted" thinking stubs (empty `thinking`
    // payload with only a signature). ThinkingBlock guards internally,
    // but filtering here keeps the behavior consistent with the
    // top-level assistant/thread renderers and avoids rendering an
    // empty wrapper.
    const thinkingBlocks = content
      .filter((block) => isThinkingBlock(block))
      .filter((block) => hasRenderableThinking(block));

    return withReplacementStatus(
      <div class="space-y-2">
        {/* Thinking blocks */}
        {thinkingBlocks.map((block, idx) => (
          <ThinkingBlock
            key={`thinking-${idx}`}
            content={(block as { thinking: string }).thinking}
            estimatedTokens={estimatedThinkingTokens}
          />
        ))}

        {/* Tool use blocks */}
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

        {/* Text blocks */}
        {textBlocks.length > 0 && (
          <div class="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
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

  // Handle user messages (typically tool results)
  if (message.type === 'user') {
    const apiMessage = message.message;
    const content = apiMessage.content;

    // Skip rendering user messages that only contain tool results
    // as they are already shown with the tool use block
    if (Array.isArray(content)) {
      const hasNonToolResultContent = content.some((block) => {
        const blockObj = block as unknown as Record<string, unknown>;
        return blockObj.type !== 'tool_result';
      });

      if (!hasNonToolResultContent) {
        return null;
      }

      // Render non-tool-result content blocks
      return withReplacementStatus(
        <div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-800">
          {content.map((block, idx) => {
            const blockObj = block as unknown as Record<string, unknown>;
            if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
              return (
                <div
                  key={idx}
                  class="text-sm text-blue-900 dark:text-blue-100 whitespace-pre-wrap break-words"
                >
                  {blockObj.text}
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }

    // Handle string content
    if (typeof content === 'string') {
      return withReplacementStatus(
        <div class="bg-blue-50 dark:bg-blue-900/20 p-3 rounded border border-blue-200 dark:border-blue-800 text-sm text-blue-900 dark:text-blue-100 whitespace-pre-wrap break-words">
          {content}
        </div>
      );
    }

    return null;
  }

  // Handle result messages
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
            'bg-gray-50 dark:bg-gray-800 p-3 rounded border',
            resultMessage.is_error
              ? 'border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'
              : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
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

  // Handle system messages
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
      <div class="bg-gray-100 dark:bg-gray-800 p-2 rounded text-xs text-gray-600 dark:text-gray-300">
        System: {(systemMessage as { subtype?: string }).subtype ?? 'message'}
      </div>
    );
  }

  // Fallback for unknown message types - show raw data
  return withReplacementStatus(
    <div class="bg-gray-100 dark:bg-gray-800 p-2 rounded text-xs">
      <details>
        <summary class="cursor-pointer text-gray-500">Unknown message type: {message.type}</summary>
        <pre class="mt-2 overflow-x-auto">{JSON.stringify(message, null, 2)}</pre>
      </details>
    </div>
  );
}
