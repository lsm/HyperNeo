import type { SDKTaskProgressMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

function formatTokens(totalTokens: number): string {
  if (totalTokens >= 1000) {
    return `${(totalTokens / 1000).toFixed(1).replace(/\.0$/, '')}k tok`;
  }
  return `${totalTokens.toLocaleString()} tok`;
}

function formatToolUses(toolUses: number): string {
  return `${toolUses.toLocaleString()} ${toolUses === 1 ? 'tool' : 'tools'}`;
}

export function TaskProgressLine({ progress }: { progress: SDKTaskProgressMessage }) {
  const segments = [
    'Running',
    formatTokens(progress.usage.total_tokens),
    formatToolUses(progress.usage.tool_uses),
    `${(progress.usage.duration_ms / 1000).toFixed(1)}s`,
  ];
  if (progress.last_tool_name) {
    segments.push(`last: ${progress.last_tool_name}`);
  }
  if (progress.summary) {
    segments.push(progress.summary);
  }

  return (
    <div
      class="border-t border-gray-200/70 dark:border-gray-700/70 px-3 py-1.5 text-xs text-fg-muted"
      aria-label="running task progress"
    >
      <span class="font-mono">{segments.join(' · ')}</span>
    </div>
  );
}
