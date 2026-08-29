import { cn } from '../../lib/utils.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';

interface SlashCommandOutputProps {
  content: string;
  className?: string;
}

const HIDDEN_OUTPUTS = ['Compacted'];

function parseCommandOutput(content: string): string | null {
  const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  return match ? match[1].trim() : null;
}

function shouldHideOutput(output: string): boolean {
  return HIDDEN_OUTPUTS.includes(output);
}

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

  if (!output) {
    return null;
  }

  if (shouldHideOutput(output)) {
    return null;
  }

  return (
    <div class={cn('py-2', className)}>
      <div class="flex items-center gap-2 mb-2">
        <TerminalIcon className="w-4 h-4 text-fg-muted" />
        <span class="text-xs font-medium text-fg-muted">Command Output</span>
      </div>

      <div
        class={cn(
          'bg-surface-raised/60 border border-line rounded-lg p-4',
          'prose prose-invert max-w-full overflow-x-auto'
        )}
      >
        <MarkdownRenderer content={output} class="text-sm" />
      </div>
    </div>
  );
}

export function isHiddenCommandOutput(content: string): boolean {
  const output = parseCommandOutput(content);
  if (!output) return false;
  return shouldHideOutput(output);
}
