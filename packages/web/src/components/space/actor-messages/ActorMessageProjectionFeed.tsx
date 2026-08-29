import type { ActorMessageProjectionRow } from '@hyperneo/shared';
import { useActorMessageProjections } from '../../../hooks/useActorMessageProjections';
import { DeliveryStateBadge } from '../../ui/DeliveryStateBadge';

const EVENT_LABELS: Record<string, string> = {
  message: 'Message',
  decision: 'Decision',
  question: 'Question',
  answer: 'Answer',
  artifact: 'Artifact',
  status: 'Status',
  handoff: 'Handoff',
  gate: 'Gate',
  retry: 'Retry',
  ci: 'CI',
  system: 'System',
  github: 'GitHub',
};

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-accent-soft',
  success: 'bg-emerald-400',
  warning: 'bg-warning',
  error: 'bg-red-400',
};

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function shorten(value: string | null | undefined, max = 220): string {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function ActorLabel({ row }: { row: ActorMessageProjectionRow }) {
  return (
    <span class="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-raised/70 px-2 py-0.5 text-[11px] font-medium text-fg-soft">
      <span class="uppercase tracking-wide text-fg-muted">{row.from.kind}</span>
      <span>{row.from.label}</span>
    </span>
  );
}

function TargetBadge({ row }: { row: ActorMessageProjectionRow }) {
  if (!row.target) return null;
  return (
    <span
      class="inline-flex items-center gap-1 rounded-md border border-line bg-surface/70 px-2 py-0.5 text-[11px] font-medium text-fg-soft"
      data-testid="actor-target-badge"
    >
      <span class="text-fg-muted">→</span>
      <span>{row.target.label}</span>
      {row.targetResolution ? <span class="text-fg-muted">({row.targetResolution})</span> : null}
    </span>
  );
}

function ProjectionRow({ row }: { row: ActorMessageProjectionRow }) {
  const eventLabel = EVENT_LABELS[row.eventKind] ?? row.eventKind;
  const dotClass = SEVERITY_DOT[row.severity ?? 'info'] ?? SEVERITY_DOT.info;
  return (
    <li class="relative pl-7" data-testid="actor-message-projection-row">
      <span class={`absolute left-0 top-2 h-2.5 w-2.5 rounded-full ${dotClass}`} />
      <div class="rounded-lg border border-line bg-surface-overlay/70 px-3 py-2.5 shadow-sm shadow-black/10">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            {eventLabel}
          </span>
          <ActorLabel row={row} />
          <TargetBadge row={row} />
          <DeliveryStateBadge state={row.deliveryState} class="text-[11px]" />
          <span class="ml-auto text-[11px] text-fg-muted">{formatClock(row.createdAt)}</span>
        </div>
        <div class="mt-2 text-sm font-medium text-fg">{row.title}</div>
        {row.summary ? (
          <p class="mt-1 text-sm leading-relaxed text-fg-soft">{shorten(row.summary)}</p>
        ) : null}
        {row.details ? (
          <p class="mt-1 text-xs leading-relaxed text-fg-muted">{shorten(row.details, 160)}</p>
        ) : null}
      </div>
    </li>
  );
}

interface ActorMessageProjectionFeedProps {
  scope: 'task_timeline' | 'workflow_log';
  taskId?: string | null;
  workflowRunId?: string | null;
  topInsetClass?: string;
  bottomInsetPx?: number;
  emptyLabel: string;
  loadingLabel: string;
  reconnectingLabel: string;
}

export function ActorMessageProjectionFeed({
  scope,
  taskId,
  workflowRunId,
  topInsetClass = 'pt-12',
  bottomInsetPx = 0,
  emptyLabel,
  loadingLabel,
  reconnectingLabel,
}: ActorMessageProjectionFeedProps) {
  const { rows, isLoading, isReconnecting } = useActorMessageProjections({
    scope,
    taskId,
    workflowRunId,
  });

  const paddingStyle = bottomInsetPx > 0 ? { paddingBottom: `${bottomInsetPx}px` } : undefined;

  if (isReconnecting || isLoading) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center text-sm text-fg-muted">
          {isReconnecting ? reconnectingLabel : loadingLabel}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center text-sm text-fg-muted">
          {emptyLabel}
        </div>
      </div>
    );
  }

  return (
    <div class={`h-full overflow-y-auto ${topInsetClass}`} style={paddingStyle}>
      <ol class="min-h-[calc(100%+1px)] space-y-3 px-4 py-4">
        {rows.map((row) => (
          <ProjectionRow key={row.id} row={row} />
        ))}
      </ol>
    </div>
  );
}
