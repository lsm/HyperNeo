/**
 * AutonomyWorkflowSummary — "X of Y workflows auto-close without review" hint.
 *
 * Rendered below the autonomy selector in Space settings and next to the
 * slim autonomy bar on the Space Overview. Updates live as the user changes
 * `level`.
 *
 * The component is purely derived from the `workflows` + `level` props — no
 * RPC, no signals, no side effects. It's safe to render inside any parent
 * that already has the workflow list in scope.
 */

import { useMemo, useState } from 'preact/hooks';
import type { SpaceAutonomyLevel, SpaceWorkflowSummary } from '@hyperneo/shared';
import { isWorkflowAutoClosingAtLevel } from '@hyperneo/shared';
import { cn } from '../../lib/utils.ts';

interface AutonomyWorkflowSummaryProps {
  level: SpaceAutonomyLevel;
  workflows: SpaceWorkflowSummary[];
  /** Optional extra tailwind classes applied to the wrapper. */
  class?: string;
  /**
   * When `true`, render in "compact" mode — smaller text and inline
   * chevron. Used on the Space Overview where space is tight.
   */
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

  // Nothing to say before workflows have loaded (or when the space has none).
  if (total === 0) {
    return null;
  }

  const hasDetails = blocking.length > 0;
  const textSize = compact ? 'text-[11px]' : 'text-xs';

  return (
    <div class={cn('space-y-1', className)} data-testid="autonomy-workflow-summary">
      <div class={cn('flex items-center gap-2', textSize, 'text-gray-400')}>
        <span data-testid="autonomy-workflow-summary-count">
          Level {level}:{' '}
          <span class="text-gray-200 font-medium tabular-nums">
            {autonomous} of {total}
          </span>{' '}
          {total === 1 ? 'workflow auto-closes' : 'workflows auto-close'} without review
        </span>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            data-testid="autonomy-workflow-summary-toggle"
            class="text-gray-400 hover:text-gray-300 transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>

      {expanded && hasDetails && (
        <ul
          class={cn('space-y-1 pl-2 border-l border-dark-700', textSize, 'text-gray-400')}
          data-testid="autonomy-workflow-summary-details"
        >
          {blocking.map((wf) => (
            <li key={wf.workflowId} class="leading-snug">
              <span class="text-gray-300">{wf.workflowName}</span>
              <> — requires level {wf.requiredLevel} or higher</>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
