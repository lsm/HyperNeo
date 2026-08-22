import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

type ToolUseSummaryMessage = Extract<SDKMessage, { type: 'tool_use_summary' }>;

interface Props {
  message: ToolUseSummaryMessage;
}

export function SDKToolUseSummaryMessage({ message }: Props) {
  const summary = message.summary?.trim();
  if (!summary) return null;

  const toolUseCount = Array.isArray(message.preceding_tool_use_ids)
    ? message.preceding_tool_use_ids.length
    : 0;

  return (
    <div
      class="my-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm dark:border-slate-700 dark:bg-slate-900/30"
      data-testid="tool-use-summary"
    >
      <svg
        class="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
        />
      </svg>
      <span class="flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Tool summary
      </span>
      {toolUseCount > 0 && (
        <span class="flex-shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          {toolUseCount} tool {toolUseCount === 1 ? 'use' : 'uses'}
        </span>
      )}
      <span
        class="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300"
        title={summary}
      >
        {summary}
      </span>
    </div>
  );
}
