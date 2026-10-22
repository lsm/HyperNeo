import { useMemo, useState } from 'preact/hooks';
import type { SpaceAutonomyLevel, SpaceWorkflowSummary } from '@hyperneo/shared';
import { isWorkflowAutoClosingAtLevel } from '@hyperneo/shared';
import { cn } from '../../lib/utils.ts';

interface AutonomyWorkflowSummaryProps {
  level: SpaceAutonomyLevel;
  workflows: SpaceWorkflowSummary[];
  class?: string;
  compact?: boolean;
}

interface BlockingEntry {
  workflowId: string;
  workflowName: string;
  requiredLevel: number;
}

export function AutonomyWorkflowSummary({
  level,
  workflows,
  class: className,
  compact = false,
}: AutonomyWorkflowSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  const { autonomous, total, blocking } = useMemo(() => {
    let auto = 0;
    const blockingList: BlockingEntry[] = [];
    for (const wf of workflows) {
      if (isWorkflowAutoClosingAtLevel(wf, level)) {
        auto += 1;
      } else {
        blockingList.push({
          workflowId: wf.id,
          workflowName: wf.name,
          requiredLevel: wf.completionAutonomyLevel ?? 5,
        });
      }
    }
    return { autonomous: auto, total: workflows.length, blocking: blockingList };
  }, [workflows, level]);

  if (total === 0) {
    return null;
  }

  const hasDetails = blocking.length > 0;
  const textSize = compact ? 'text-[11px]' : 'text-xs';

  return (
    <div class={cn('space-y-1', className)} data-testid="autonomy-workflow-summary">
      <div class={cn('flex items-center gap-2', textSize, 'text-fg-muted')}>
        <span data-testid="autonomy-workflow-summary-count">
          Level {level}:{' '}
          <span class="text-fg-soft font-medium tabular-nums">
            {autonomous} of {total}
          </span>{' '}
          {total === 1 ? 'workflow auto-closes' : 'workflows auto-close'} without review
        </span>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            data-testid="autonomy-workflow-summary-toggle"
            class="text-fg-muted hover:text-fg-soft transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>

      {expanded && hasDetails && (
        <ul
          class={cn('space-y-1 pl-2 border-l border-line', textSize, 'text-fg-muted')}
          data-testid="autonomy-workflow-summary-details"
        >
          {blocking.map((wf) => (
            <li key={wf.workflowId} class="leading-snug">
              <span class="text-fg-soft">{wf.workflowName}</span>
              <> — requires level {wf.requiredLevel} or higher</>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
