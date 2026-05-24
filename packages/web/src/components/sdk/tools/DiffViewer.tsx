/**
 * DiffViewer - Component for displaying file diffs
 *
 * Displays side-by-side or unified diff view for file changes,
 * particularly useful for Edit tool output.
 */

import { cn } from '../../../lib/utils.ts';

export interface DiffViewerProps {
  /** The original text (before changes) */
  oldText: string;
  /** The new text (after changes) */
  newText: string;
  /** File path being edited */
  filePath?: string;
  /** Display mode: 'unified' (default) or 'split' */
  mode?: 'unified' | 'split';
  /** Custom class names */
  className?: string;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'separator';
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

/**
 * Simple diff algorithm that finds the changed section
 */
function generateDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff: DiffLine[] = [];

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

  // Add context lines before the change (up to 3 lines)
  const contextBefore = Math.max(0, firstDiffIndex - 3);
  for (let i = contextBefore; i < firstDiffIndex; i++) {
    diff.push({
      type: 'context',
      oldLineNum: i + 1,
      newLineNum: i + 1,
      content: oldLines[i],
    });
  }

  // Add separator if there's context before
  if (contextBefore > 0) {
    diff.push({
      type: 'separator',
      content: '...',
    });
  }

  // Add removed lines
  for (let i = firstDiffIndex; i <= lastDiffIndexOld; i++) {
    diff.push({
      type: 'remove',
      oldLineNum: i + 1,
      content: oldLines[i],
    });
  }

  // Add added lines
  for (let i = firstDiffIndex; i <= lastDiffIndexNew; i++) {
    diff.push({
      type: 'add',
      newLineNum: i + 1,
      content: newLines[i],
    });
  }

  // Add context lines after the change (up to 3 lines)
  const contextAfter = Math.min(oldLines.length, lastDiffIndexOld + 4);
  for (let i = lastDiffIndexOld + 1; i < contextAfter; i++) {
    if (i < oldLines.length) {
      diff.push({
        type: 'context',
        oldLineNum: i + 1,
        newLineNum: i - lastDiffIndexOld + lastDiffIndexNew + 1,
        content: oldLines[i],
      });
    }
  }

  // Add separator if there's more context after
  if (contextAfter < oldLines.length) {
    diff.push({
      type: 'separator',
      content: '...',
    });
  }

  return diff;
}

export function DiffViewer({
  oldText,
  newText,
  filePath,
  mode: _mode = 'unified',
  className,
}: DiffViewerProps) {
  const diff = generateDiff(oldText, newText);
  const addedLines = diff.filter((l) => l.type === 'add').length;
  const removedLines = diff.filter((l) => l.type === 'remove').length;

  return (
    <div
      class={cn(
        'rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700',
        className
      )}
    >
      {/* Header */}
      {filePath && (
        <div class="bg-gray-100 dark:bg-gray-800 px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div class="text-xs font-mono text-gray-700 dark:text-gray-300">{filePath}</div>
          <div class="text-xs font-mono flex items-center gap-1">
            <span class="text-green-700 dark:text-green-400">+{addedLines}</span>
            <span class="text-red-700 dark:text-red-400">-{removedLines}</span>
          </div>
        </div>
      )}

      {/* Diff content */}
      <div class="bg-gray-50 dark:bg-gray-900 overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <tbody>
            {diff.map((line, idx) => {
              if (line.type === 'separator') {
                return (
                  <tr key={idx} class="bg-gray-100 dark:bg-gray-800">
                    <td
                      class="px-2 py-1 text-center text-gray-500 dark:text-gray-400 select-none"
                      colSpan={3}
                    >
                      {line.content}
                    </td>
                  </tr>
                );
              }

              const bgClass =
                line.type === 'add'
                  ? 'bg-green-50 dark:bg-green-900/20'
                  : line.type === 'remove'
                    ? 'bg-red-50 dark:bg-red-900/20'
                    : 'bg-white dark:bg-gray-900';

              const textClass =
                line.type === 'add'
                  ? 'text-green-900 dark:text-green-100'
                  : line.type === 'remove'
                    ? 'text-red-900 dark:text-red-100'
                    : 'text-gray-700 dark:text-gray-300';

              const signClass =
                line.type === 'add'
                  ? 'text-green-700 dark:text-green-400'
                  : line.type === 'remove'
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-gray-500 dark:text-gray-500';

              const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
              const lineNum = line.type === 'add' ? line.newLineNum : line.oldLineNum;

              return (
                <tr key={idx} class={bgClass}>
                  {/* Line number */}
                  <td class="px-2 py-0.5 text-right text-gray-500 dark:text-gray-500 select-none w-12 border-r border-gray-200 dark:border-gray-700">
                    {lineNum}
                  </td>
                  {/* Sign */}
                  <td class={cn('px-2 py-0.5 w-6 select-none', signClass)}>{sign}</td>
                  {/* Content */}
                  <td class={cn('px-2 py-0.5 whitespace-pre', textClass)}>{line.content || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Stats footer */}
      <div class="bg-gray-100 dark:bg-gray-800 px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 flex gap-4 text-xs">
        <div class="flex items-center gap-1">
          <span class="text-green-700 dark:text-green-400">+</span>
          <span class="text-gray-700 dark:text-gray-300">
            {diff.filter((l) => l.type === 'add').length} additions
          </span>
        </div>
        <div class="flex items-center gap-1">
          <span class="text-red-700 dark:text-red-400">-</span>
          <span class="text-gray-700 dark:text-gray-300">
            {diff.filter((l) => l.type === 'remove').length} deletions
          </span>
        </div>
      </div>
    </div>
  );
}
