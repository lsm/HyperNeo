/**
 * SlashCommandOutput Component - Renders slash command output from <local-command-stdout> tags
 *
 * Handles:
 * - Parsing <local-command-stdout> content
 * - Hiding redundant outputs (e.g., "Compacted" which is shown in CompactBoundaryMessage)
 * - Rendering command output in a consistent style
 */

import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';

interface SlashCommandOutputProps {
  /** Raw content that may contain <local-command-stdout> tags */
  content: string;
  /** Optional CSS classes */
  className?: string;
}

/** Commands whose output should be hidden (shown elsewhere in UI) */
const HIDDEN_OUTPUTS = ['Compacted'];

/**
 * Parse <local-command-stdout> content from raw message
 */
function parseCommandOutput(content: string): string | null {
  const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  return match ? match[1].trim() : null;
}

/**
 * Check if this output should be hidden
 */
function shouldHideOutput(output: string): boolean {
  return HIDDEN_OUTPUTS.includes(output);
}

/**
 * Terminal icon for command output
 */
function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg class={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

export function SlashCommandOutput({ content, className }: SlashCommandOutputProps) {
  const output = parseCommandOutput(content);

  // No command output found
  if (!output) {
    return null;
  }

  // Hide redundant outputs
  if (shouldHideOutput(output)) {
    return null;
  }

  return (
    <div class={cn('py-2', className)}>
      {/* Header */}
      <div class="flex items-center gap-2 mb-2">
        <TerminalIcon className="w-4 h-4 text-gray-400" />
        <span class="text-xs font-medium text-gray-400">Command Output</span>
      </div>

      {/* Output content */}
      <div
        class={cn(
          `bg-dark-800/60 border ${borderColors.ui.default} rounded-lg p-4`,
          'prose prose-invert max-w-full overflow-x-auto'
        )}
      >
        <MarkdownRenderer content={output} class="text-sm" />
      </div>
    </div>
  );
}

/**
 * Check if content is a hidden command output (like "Compacted")
 * Useful for skipping entire message rendering
 */
export function isHiddenCommandOutput(content: string): boolean {
  const output = parseCommandOutput(content);
  if (!output) return false;
  return shouldHideOutput(output);
}
