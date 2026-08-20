import type { TaskMilestoneRow } from '@hyperneo/shared';
import { useMemo } from 'preact/hooks';
import { useTaskMilestones } from '../../hooks/useTaskMilestones';
import { useVisibleTick } from '../../hooks/useVisibleTick';
import { INDICATOR_TONES } from '../../lib/indicator-tokens';
import { curateTaskMilestones, formatRelativeTimestamp } from '../../lib/task-milestones';
import { cn } from '../../lib/utils';

function SourceChip({ row }: { row: TaskMilestoneRow }) {
  if (!row.sourceLabel) return null;
  const toneSet = INDICATOR_TONES[row.tone] ?? INDICATOR_TONES.neutral;
  return (
    <span
      class={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
        toneSet.soft
      )}
    >
      {row.sourceLabel}
    </span>
  );
}

function MilestoneRow({
  row,
  showTime,
  timeLabel,
}: {
  row: TaskMilestoneRow;
  showTime: boolean;
  timeLabel: string;
}) {
  const toneSet = INDICATOR_TONES[row.tone] ?? INDICATOR_TONES.neutral;
  return (
    <li class="relative pl-6" data-testid="task-milestone-row">
      <span
        class={cn(
          'absolute left-0 top-2.5 h-2.5 w-2.5 rounded-full ring-2 ring-dark-900',
          toneSet.bg
        )}
      />
      <div class="rounded-lg border border-dark-700 bg-dark-850/70 px-3 py-2 shadow-sm shadow-black/10">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-gray-100">{row.title}</span>
          <SourceChip row={row} />
          <span class="ml-auto text-[11px] tabular-nums text-gray-400">
            {showTime ? timeLabel : ''}
          </span>
        </div>
        {row.body ? (
          <p class="mt-1 line-clamp-3 text-sm leading-relaxed text-gray-300">{row.body}</p>
        ) : null}
      </div>
    </li>
  );
}

interface TaskMilestoneTimelineProps {
  taskId: string;
  topInsetClass?: string;
  bottomInsetPx?: number;
}

export function TaskMilestoneTimeline({
  taskId,
  topInsetClass = 'pt-12',
  bottomInsetPx = 0,
}: TaskMilestoneTimelineProps) {
  const { rows, isLoading, isReconnecting } = useTaskMilestones({ taskId });
  const curated = useMemo(() => curateTaskMilestones(rows), [rows]);
  useVisibleTick(60_000);
  const now = Date.now();

  const paddingStyle = bottomInsetPx > 0 ? { paddingBottom: `${bottomInsetPx}px` } : undefined;

  if (isReconnecting || isLoading) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center text-sm text-gray-400">
          {isReconnecting ? 'Reconnecting task timeline…' : 'Loading task timeline…'}
        </div>
      </div>
    );
  }

  if (curated.length === 0) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center text-sm text-gray-400">
          No task timeline events yet.
        </div>
      </div>
    );
  }

  let prevLabel = '';
  const rendered = curated.map((row) => {
    const label = formatRelativeTimestamp(row.createdAt, now);
    const showTime = label !== prevLabel;
    if (showTime) prevLabel = label;
    return { row, showTime, label };
  });

  return (
    <div class={cn('h-full overflow-y-auto', topInsetClass)} style={paddingStyle}>
      <ol class="min-h-[calc(100%+1px)] space-y-2.5 px-4 py-4">
        {rendered.map(({ row, showTime, label }) => (
          <MilestoneRow key={row.id} row={row} showTime={showTime} timeLabel={label} />
        ))}
      </ol>
    </div>
  );
}
