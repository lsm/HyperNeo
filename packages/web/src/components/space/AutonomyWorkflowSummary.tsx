import { useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SpaceAutonomyLevel, SpaceWorkflowSummary } from '@hyperneo/shared';
import { isWorkflowAutoClosingAtLevel } from '@hyperneo/shared';
import { ContentDisclosureControl } from '../ui/ContentDisclosureControl.tsx';
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
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const id = useId();
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`button[id="${id}-toggle"]`)
      ?.focus({ preventScroll: true });
  }, [expanded, id]);

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
  const control = hasDetails && (
    <ContentDisclosureControl
      id={`${id}-toggle`}
      expanded={expanded}
      aria-label="Workflow details"
      aria-controls={expanded ? id : undefined}
      data-testid="autonomy-workflow-summary-toggle"
      onToggle={() => {
        restoreFocus.current = true;
        setExpanded(!expanded);
      }}
    />
  );

  return (
    <div ref={rootRef} class={cn('space-y-1', className)} data-testid="autonomy-workflow-summary">
      <div class={cn('flow-root', textSize, 'text-fg-muted')}>
        <span data-testid="autonomy-workflow-summary-count">
          Level {level}:{' '}
          <span class="text-fg-soft font-medium tabular-nums">
            {autonomous} of {total}
          </span>{' '}
          {total === 1 ? 'workflow auto-closes' : 'workflows auto-close'} without review
        </span>
        {!expanded && control}
      </div>

      {expanded && hasDetails && (
        <ul
          id={id}
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
      {expanded && <div class="flow-root">{control}</div>}
    </div>
  );
}
