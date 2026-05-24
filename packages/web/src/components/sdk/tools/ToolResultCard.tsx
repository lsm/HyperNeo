/**
 * ToolResultCard Component - Displays completed tool execution results with syntax highlighting
 */

import { useState } from 'preact/hooks';
import type { ToolResultCardProps } from './tool-types.ts';
import { ToolIcon } from './ToolIcon.tsx';
import { ToolSummary } from './ToolSummary.tsx';
import { DiffViewer } from './DiffViewer.tsx';
import { CodeViewer } from './CodeViewer.tsx';
import {
  getToolDisplayName,
  getToolColors,
  getOutputDisplayText,
  hasCustomRenderer,
  getCustomRenderer,
  shouldExpandByDefault,
} from './tool-utils.ts';
import { isFileReadOutput, isFileEditOutput, isFileWriteOutput } from './sdk-tool-types.ts';
import { cn } from '../../../lib/utils.ts';
import { RunningBorder } from '../RunningBorder.tsx';
import { connectionManager } from '../../../lib/connection-manager.ts';
import { toast } from '../../../lib/toast.ts';
import { ConfirmModal } from '../../ui/ConfirmModal.tsx';

/**
 * Strip line numbers from Read tool output
 * Read tool output format: "   1→content\n   2→content"
 */
function stripLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      // Match pattern: optional spaces, digits, →, then content
      const match = line.match(/^\s*\d+→(.*)$/);
      return match ? match[1] : line;
    })
    .join('\n');
}

/**
 * Build a unified diff string from a structured patch for display fallback
 */
function structuredPatchToDiff(
  patch: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[]
): string {
  return patch
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      return [header, ...hunk.lines].join('\n');
    })
    .join('\n');
}

/**
 * ToolResultCard Component
 */
export function ToolResultCard({
  toolName,
  toolId,
  input,
  output,
  isError = false,
  variant = 'default',
  defaultExpanded,
  messageUuid,
  sessionId,
  isOutputRemoved = false,
  disableExpand = false,
  className,
  isRunning = false,
}: ToolResultCardProps) {
  // Type-safe access to input/output properties
  const inputRecord = input as Record<string, unknown>;
  const outputRecord = (output || {}) as Record<string, unknown>;

  const colors = getToolColors(toolName);
  const displayName = getToolDisplayName(toolName);
  const shouldExpand =
    defaultExpanded !== undefined ? defaultExpanded : shouldExpandByDefault(toolName);
  const [isExpanded, setIsExpanded] = useState(shouldExpand);
  const [deleting, setDeleting] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const customRenderer = hasCustomRenderer(toolName) ? getCustomRenderer(toolName) : null;

  const handleDeleteClick = () => {
    if (!messageUuid || !sessionId) {
      toast.error('Cannot delete: missing message or session ID');
      return;
    }
    setShowConfirmModal(true);
  };

  const handleConfirmDelete = async () => {
    try {
      setDeleting(true);
      const hub = await connectionManager.getHub();
      await hub.request('message.removeOutput', {
        sessionId,
        messageUuid,
      });
      toast.success('Tool output removed. Reloading session...');
      setShowConfirmModal(false);

      // Reload the page to refresh messages
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to remove output';
      toast.error(errorMessage);
      setDeleting(false);
    }
  };

  // Compact variant - minimal display
  if (variant === 'compact') {
    return (
      <div
        class={cn(
          'flex items-center gap-2 py-1 px-2 rounded border',
          colors.bg,
          colors.border,
          className
        )}
      >
        <ToolIcon toolName={toolName} size="sm" />
        <span class={cn('text-xs font-medium truncate', colors.text)}>{displayName}</span>
        {isError && (
          <svg
            class="w-3 h-3 text-red-500 ml-auto flex-shrink-0"
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
      </div>
    );
  }

  // Inline variant - for text flow
  if (variant === 'inline') {
    return (
      <span
        class={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded', colors.bg, className)}
      >
        <ToolIcon toolName={toolName} size="xs" />
        <span class={cn('text-xs font-medium', colors.text)}>{displayName}</span>
        {isError && <span class="text-xs text-red-500">✗</span>}
      </span>
    );
  }

  // Helper function to calculate diff line counts (same logic as DiffViewer)
  const calculateDiffCounts = (oldText: string, newText: string) => {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Find the first different line
    let firstDiffIndex = 0;
    while (
      firstDiffIndex < Math.min(oldLines.length, newLines.length) &&
      oldLines[firstDiffIndex] === newLines[firstDiffIndex]
    ) {
      firstDiffIndex++;
    }

    // Find the last different line
    let lastDiffIndexOld = oldLines.length - 1;
    let lastDiffIndexNew = newLines.length - 1;
    while (
      lastDiffIndexOld > firstDiffIndex &&
      lastDiffIndexNew > firstDiffIndex &&
      oldLines[lastDiffIndexOld] === newLines[lastDiffIndexNew]
    ) {
      lastDiffIndexOld--;
      lastDiffIndexNew--;
    }

    const removedLines = lastDiffIndexOld - firstDiffIndex + 1;
    const addedLines = lastDiffIndexNew - firstDiffIndex + 1;

    return { addedLines, removedLines };
  };

  // Calculate line counts for Read, Write, Edit tools
  const getLineCountDisplay = () => {
    if (toolName === 'Read') {
      if (isFileReadOutput(output) && output.type === 'text') {
        return (
          <span class="text-xs text-gray-600 dark:text-gray-400 font-mono">
            {output.file.numLines}
          </span>
        );
      }
      // Fallback for legacy string/object output
      const content =
        typeof output === 'string'
          ? output
          : output && typeof output === 'object'
            ? (outputRecord.content as string | undefined)
            : undefined;
      if (content && typeof content === 'string') {
        const lineCount = content.split('\n').length;
        return <span class="text-xs text-gray-600 dark:text-gray-400 font-mono">{lineCount}</span>;
      }
    } else if (toolName === 'Write') {
      // Count lines in input content
      const content = inputRecord?.content as string | undefined;
      if (content && typeof content === 'string') {
        const lineCount = content.split('\n').length;
        return (
          <span class="text-xs text-green-700 dark:text-green-400 font-mono">+{lineCount}</span>
        );
      }
    } else if (toolName === 'Edit') {
      // Count actual diff changes (not total lines)
      const oldText = inputRecord?.old_string as string | undefined;
      const newText = inputRecord?.new_string as string | undefined;
      if (oldText && newText) {
        const { addedLines, removedLines } = calculateDiffCounts(oldText, newText);
        return (
          <span class="text-xs font-mono flex items-center gap-1">
            <span class="text-green-700 dark:text-green-400">+{addedLines}</span>
            <span class="text-red-700 dark:text-red-400">-{removedLines}</span>
          </span>
        );
      }
    }
    return null;
  };

  const lineCountDisplay = getLineCountDisplay();

  // Default & detailed variants - full display with expand/collapse
  // Note: the running-state arc is rendered by <RunningBorder> as an absolutely
  // positioned SVG sibling (applied via a wrapper below). It cannot live on this
  // div because overflow:hidden would clip the SVG that extends slightly past
  // the card's outer edge.
  const card = (
    <div class={cn('border rounded-lg overflow-hidden', colors.bg, colors.border, className)}>
      {/* Header - clickable to expand/collapse */}
      <button
        onClick={() => !disableExpand && setIsExpanded(!isExpanded)}
        class={cn(
          'w-full flex items-center justify-between p-3 transition-colors',
          'hover:bg-opacity-80 dark:hover:bg-opacity-80'
        )}
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <ToolIcon toolName={toolName} size="md" />
          <span class={cn('font-semibold text-sm flex-shrink-0', colors.text)}>{displayName}</span>
          <span class={cn('text-sm font-mono truncate', colors.lightText)}>
            <ToolSummary toolName={toolName} input={input} maxLength={60} />
          </span>
        </div>

        <div class="flex items-center gap-2 flex-shrink-0">
          {lineCountDisplay}
          {isError && (
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
          {!disableExpand && (
            <svg
              class={cn(
                'w-5 h-5 transition-transform',
                colors.iconColor,
                isExpanded ? 'rotate-180' : ''
              )}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          )}
        </div>
      </button>

      {/* Expanded content - input and output details */}
      {isExpanded && (
        <div class={cn('p-3 border-t bg-white dark:bg-gray-900 space-y-3', colors.border)}>
          {/* Error display takes priority when tool failed */}
          {isError && output !== undefined && output !== null && (
            <div>
              <div class="text-xs font-semibold text-red-600 dark:text-red-400 mb-2">
                Error
                {inputRecord?.file_path && (
                  <span class="font-normal text-gray-500 dark:text-gray-400 ml-1">
                    — {String(inputRecord.file_path)}
                  </span>
                )}
              </div>
              <pre
                class={cn(
                  'text-xs p-3 rounded overflow-x-auto border',
                  'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
                )}
              >
                {getOutputDisplayText(output)}
              </pre>
            </div>
          )}

          {/* Custom renderer takes priority */}
          {customRenderer ? (
            customRenderer({ toolName, input, output, isError, variant })
          ) : /* Special handling for Edit tool - show diff view */
          toolName === 'Edit' && !isError ? (
            isFileEditOutput(output) ? (
              <div class="space-y-3">
                <DiffViewer
                  oldText={output.oldString}
                  newText={output.newString}
                  filePath={output.filePath}
                />
                {output.structuredPatch.length > 0 && variant === 'detailed' && (
                  <details>
                    <summary class="text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
                      Structured patch
                    </summary>
                    <CodeViewer
                      code={structuredPatchToDiff(output.structuredPatch)}
                      filePath={output.filePath}
                      language="diff"
                      showLineNumbers={false}
                      showHeader={false}
                      maxHeight="none"
                    />
                  </details>
                )}
                {output.gitDiff && (
                  <div class="text-xs text-gray-500 dark:text-gray-400">
                    Git: {output.gitDiff.additions} additions, {output.gitDiff.deletions} deletions
                  </div>
                )}
              </div>
            ) : inputRecord?.old_string && inputRecord?.new_string ? (
              <DiffViewer
                oldText={inputRecord.old_string as string}
                newText={inputRecord.new_string as string}
                filePath={inputRecord.file_path as string | undefined}
              />
            ) : null
          ) : /* Special handling for Read tool - show syntax-highlighted code */
          toolName === 'Read' && !isError ? (
            isFileReadOutput(output) ? (
              output.type === 'text' ? (
                <CodeViewer
                  code={stripLineNumbers(output.file.content)}
                  filePath={output.file.filePath}
                  showLineNumbers={true}
                  showHeader={true}
                  maxHeight="none"
                />
              ) : output.type === 'file_unchanged' ? (
                <div class="text-xs text-gray-500 dark:text-gray-400 italic">
                  File unchanged: {output.file.filePath}
                </div>
              ) : output.type === 'image' ? (
                <img
                  src={`data:${output.file.type};base64,${output.file.base64}`}
                  alt="Read tool result"
                  class="max-w-full rounded border"
                />
              ) : (
                <pre class="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded overflow-x-auto border border-gray-200 dark:border-gray-700">
                  {JSON.stringify(output, null, 2)}
                </pre>
              )
            ) : output &&
              (typeof output === 'string' ||
                (typeof output === 'object' &&
                  'content' in output &&
                  output.content &&
                  typeof (output as Record<string, unknown>).content === 'string')) ? (
              <CodeViewer
                code={stripLineNumbers(
                  typeof output === 'string'
                    ? output
                    : ((output as Record<string, unknown>).content as string)
                )}
                filePath={inputRecord?.file_path as string | undefined}
                showLineNumbers={true}
                showHeader={true}
                maxHeight="none"
              />
            ) : null
          ) : /* Special handling for Write tool - show syntax-highlighted code */
          toolName === 'Write' && !isError ? (
            isFileWriteOutput(output) ? (
              <div>
                {variant === 'detailed' && (
                  <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                    {output.type === 'create' ? 'New File' : 'Updated File'}: {output.filePath}
                  </div>
                )}
                <CodeViewer
                  code={output.content}
                  filePath={output.filePath}
                  showLineNumbers={true}
                  showHeader={true}
                  maxHeight="none"
                />
                {output.gitDiff && (
                  <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Git: {output.gitDiff.additions} additions, {output.gitDiff.deletions} deletions
                  </div>
                )}
              </div>
            ) : inputRecord?.content && typeof inputRecord.content === 'string' ? (
              <div>
                {variant === 'detailed' && (
                  <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                    File Content:
                  </div>
                )}
                <CodeViewer
                  code={inputRecord.content as string}
                  filePath={inputRecord.file_path as string | undefined}
                  showLineNumbers={true}
                  showHeader={true}
                  maxHeight="none"
                />
              </div>
            ) : null
          ) : /* Special handling for Thinking tool - just show the content */
          toolName === 'Thinking' ? (
            <div>
              {variant === 'detailed' && (
                <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                  Extended Thinking Process ({typeof input === 'string' ? input.length : 0}{' '}
                  characters)
                </div>
              )}
              <div
                class={cn('text-xs p-3 rounded overflow-x-auto border', colors.bg, colors.border)}
              >
                <pre class={cn('text-sm whitespace-pre-wrap font-mono', colors.text)}>
                  {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
                </pre>
              </div>
              {variant === 'detailed' && (
                <div class="text-xs text-gray-500 dark:text-gray-400 italic">
                  This is Claude's internal reasoning process before generating the final response.
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Tool ID (only in detailed variant) */}
              {variant === 'detailed' && (
                <div>
                  <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">
                    Tool ID:
                  </div>
                  <div class="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
                    {toolId}
                  </div>
                </div>
              )}

              {/* Input */}
              <div>
                <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                  Input:
                </div>
                <pre class="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded overflow-x-auto border border-gray-200 dark:border-gray-700">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>

              {/* Output/Result */}
              {!isError && output !== undefined && output !== null && (
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <div class="text-xs font-semibold text-gray-600 dark:text-gray-400">
                      Output:
                    </div>
                    {messageUuid && sessionId && !isOutputRemoved && (
                      <button
                        onClick={handleDeleteClick}
                        disabled={deleting}
                        class="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
                        title="Remove this tool output from context to reduce session size"
                      >
                        <svg
                          class="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                        <span>{deleting ? 'Removing...' : 'Remove From Context'}</span>
                      </button>
                    )}
                  </div>
                  {isOutputRemoved ? (
                    <div class="p-3 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
                      <div class="flex items-start gap-2">
                        <svg
                          class="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        <div class="flex-1">
                          <div class="text-sm font-medium text-amber-900 dark:text-amber-100 mb-1">
                            Output Removed from Agent Context
                          </div>
                          <div class="text-xs text-amber-800 dark:text-amber-200">
                            This tool output has been removed from the Claude Agent SDK session file
                            to save context window space. What you see here is stored in the
                            database for reference only and will not be sent to the agent in future
                            requests.
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <pre
                      class={cn(
                        'text-xs p-3 rounded overflow-x-auto border',
                        isError
                          ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
                          : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                      )}
                    >
                      {getOutputDisplayText(output)}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Confirmation Modal */}
      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={handleConfirmDelete}
        title="Remove Tool Output From Context"
        message="Are you sure you want to remove this tool output from context? It will be replaced with a placeholder message to save context window space."
        confirmText="Remove From Context"
        cancelText="Cancel"
        confirmButtonVariant="danger"
        isLoading={deleting}
      />
    </div>
  );
  if (isRunning) {
    return <RunningBorder borderRadius={8}>{card}</RunningBorder>;
  }
  return card;
}
