import type { ToolSummaryProps } from './tool-types.ts';
import { getToolSummary, truncateText } from './tool-utils.ts';
import { Tooltip } from '../../ui/Tooltip.tsx';
import { cn } from '../../../lib/utils.ts';

export function ToolSummary({
  toolName,
  input,
  maxLength = 50,
  showTooltip = true,
  className,
}: ToolSummaryProps) {
  const summary = getToolSummary(toolName, input);
  const truncated = maxLength > 0 ? truncateText(summary, maxLength) : summary;
  const isTruncated = truncated !== summary;

  if (showTooltip && isTruncated) {
    return (
      <Tooltip content={summary} position="top">
        <span class={cn('font-mono truncate', className)} title={summary}>
          {truncated}
        </span>
      </Tooltip>
    );
  }

  return (
    <span class={cn('font-mono truncate', className)} title={isTruncated ? summary : undefined}>
      {truncated}
    </span>
  );
}
