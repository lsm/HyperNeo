import type { SpaceBlockReason, SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import {
  InlineStatusBanner,
  type InlineStatusBannerAction,
  type InlineStatusBannerTone,
} from './InlineStatusBanner';

interface TaskBlockedBannerProps {
  task: SpaceTask;
  spaceId: string;
  onStatusTransition?: (newStatus: SpaceTaskStatus) => void;
}

interface ReasonConfig {
  label: string;
  tone: InlineStatusBannerTone;
  icon: string;
}

const REASON_CONFIG: Partial<Record<SpaceBlockReason, ReasonConfig>> = {
  execution_failed: { label: 'Execution Failed', tone: 'red', icon: '⚠️' },
  agent_crashed: { label: 'Agent Crashed', tone: 'red', icon: '⚠️' },
  dependency_failed: { label: 'Blocked by Dependency', tone: 'gray', icon: '⛓️' },
  dependency_added: { label: 'Blocked by Dependency', tone: 'gray', icon: '⛓️' },
  workflow_invalid: { label: 'Invalid Workflow', tone: 'red', icon: '⚠️' },
};

const FALLBACK_CONFIG: ReasonConfig = { label: 'Blocked', tone: 'amber', icon: '⚠️' };

export function TaskBlockedBanner({
  task,
  spaceId: _spaceId,
  onStatusTransition,
}: TaskBlockedBannerProps) {
  const reason = task.blockReason;

  const actions: InlineStatusBannerAction[] = [
    {
      label: 'Reopen',
      onClick: () => onStatusTransition?.('in_progress'),
      variant: 'secondary',
      testId: 'task-blocked-reopen-btn',
    },
    {
      label: 'Cancel',
      onClick: () => onStatusTransition?.('cancelled'),
      variant: 'danger',
      testId: 'task-blocked-cancel-btn',
    },
  ];

  if (reason === 'human_input_requested') {
    return (
      <InlineStatusBanner
        tone="blue"
        icon={<span aria-hidden="true">💬</span>}
        label="Awaiting your input — reply via the composer below."
        actions={actions}
        testId="task-blocked-banner"
        dataAttrs={{ 'data-reason': 'human_input_requested' }}
      />
    );
  }

  const config = (reason && REASON_CONFIG[reason]) || FALLBACK_CONFIG;

  const result = task.result?.trim();

  return (
    <>
      <InlineStatusBanner
        tone={config.tone}
        icon={<span aria-hidden="true">{config.icon}</span>}
        label={config.label}
        meta={result ? `— ${result}` : undefined}
        actions={actions}
        testId="task-blocked-banner"
        dataAttrs={reason ? { 'data-reason': reason } : undefined}
      />
      {result && (
        <span class="sr-only" data-testid="task-blocked-message">
          {result}
        </span>
      )}
    </>
  );
}
