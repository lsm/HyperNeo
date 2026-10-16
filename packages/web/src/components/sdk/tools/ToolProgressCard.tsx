import type { ToolProgressCardProps } from './tool-types.ts';
import { ToolIcon } from './ToolIcon.tsx';
import { ToolSummary } from './ToolSummary.tsx';
import { getToolDisplayName, getToolColors, formatElapsedTime } from './tool-utils.ts';
import { cn } from '../../../lib/utils.ts';

export function ToolProgressCard({
  toolName,
  toolInput,
  elapsedTime,
  toolUseId,
  parentToolUseId,
  className,
}: ToolProgressCardProps) {
  const colors = getToolColors(toolName);
  const displayName = getToolDisplayName(toolName);

  return (
    <div
      class={cn(
        'py-2 px-3 rounded-lg border flex items-center gap-3',
        colors.bg,
        colors.border,
        className
      )}
    >
      <div class="flex-shrink-0">
        <ToolIcon toolName={toolName} size="md" animated />
      </div>

      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class={cn('font-mono text-sm font-medium', colors.text)}>{displayName}</span>
          <span class={cn('text-xs', colors.lightText)}>{formatElapsedTime(elapsedTime)}</span>
        </div>

        {toolInput ? (
          <div class={cn('text-xs truncate', colors.lightText)}>
            <ToolSummary toolName={toolName} input={toolInput} maxLength={60} />
          </div>
        ) : (
          <div class={cn('text-xs truncate', colors.lightText)}>
            Tool ID: {toolUseId.slice(0, 12)}...
            {parentToolUseId && (
              <span class="ml-2">(parent: {parentToolUseId.slice(0, 8)}...)</span>
            )}
          </div>
        )}
      </div>

      <div class="flex-shrink-0">
        <div class="flex gap-1">
          <div
            class={cn('w-1.5 h-1.5 rounded-full animate-pulse', colors.iconColor)}
            style="animation-delay: 0ms"
          />
          <div
            class={cn('w-1.5 h-1.5 rounded-full animate-pulse', colors.iconColor)}
            style="animation-delay: 150ms"
          />
          <div
            class={cn('w-1.5 h-1.5 rounded-full animate-pulse', colors.iconColor)}
            style="animation-delay: 300ms"
          />
        </div>
      </div>
    </div>
  );
}
