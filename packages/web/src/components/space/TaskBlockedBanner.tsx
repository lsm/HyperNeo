/**
 * TaskBlockedBanner — reason-aware banner for blocked tasks.
 *
 * Replaces the generic amber blocked banner in SpaceTaskPane with
 * distinct UI per blockReason:
 *   - human_input_requested: tiny "reply via composer" hint — the question
 *     itself is surfaced as a "Question" message in the thread (see
 *     space-task-thread-events.ts), so we don't duplicate it here. The hint
 *     is a safety net: if the thread transformation ever fails to render the
 *     question, the user still sees that input is required.
 *   - gate_rejected: purple — shows gate info + "Review & Approve" expanding to GateArtifactsView
 *   - execution_failed / agent_crashed: red — shows error + Resume button
 *   - dependency_failed / dependency_added: gray — informational
 *   - workflow_invalid: red — informational
 *   - (null / unknown): amber fallback — matches previous behavior
 *
 * Composes `InlineStatusBanner` for the one-line status row so blocked tasks
 * share the thin-banner shape with all other task-pane banners (gate,
 * task-completion, post-approval). The blocked-task reason text from
 * `task.result` is surfaced as banner `meta` when present.
 */

import { useState, useEffect } from 'preact/hooks';
import type { SpaceBlockReason, SpaceTask, SpaceTaskStatus } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { GateArtifactsView } from './GateArtifactsView';
import {
  InlineStatusBanner,
  type InlineStatusBannerAction,
  type InlineStatusBannerTone,
} from './InlineStatusBanner';

interface TaskBlockedBannerProps {
  task: SpaceTask;
  spaceId: string;
  /** Called when the user triggers a status transition (e.g. Resume → in_progress) */
  onStatusTransition?: (newStatus: SpaceTaskStatus) => void;
}

interface PendingGate {
  gateId: string;
  data: Record<string, unknown>;
}

interface ReasonConfig {
  label: string;
  tone: InlineStatusBannerTone;
  icon: string;
}

const REASON_CONFIG: Partial<Record<SpaceBlockReason, ReasonConfig>> = {
  gate_rejected: { label: 'Gate Pending Approval', tone: 'purple', icon: '🔒' },
  execution_failed: { label: 'Execution Failed', tone: 'red', icon: '⚠️' },
  agent_crashed: { label: 'Agent Crashed', tone: 'red', icon: '⚠️' },
  dependency_failed: { label: 'Blocked by Dependency', tone: 'gray', icon: '⛓️' },
  dependency_added: { label: 'Blocked by Dependency', tone: 'gray', icon: '⛓️' },
  workflow_invalid: { label: 'Invalid Workflow', tone: 'red', icon: '⚠️' },
};

const FALLBACK_CONFIG: ReasonConfig = { label: 'Blocked', tone: 'amber', icon: '⚠️' };

export function TaskBlockedBanner({ task, spaceId, onStatusTransition }: TaskBlockedBannerProps) {
  const reason = task.blockReason;

  const [showGateReview, setShowGateReview] = useState(false);
  const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);

  // For gate_rejected tasks, fetch the pending gate data on mount
  useEffect(() => {
    if (reason !== 'gate_rejected' || !task.workflowRunId) return;

    let cancelled = false;
    spaceStore
      .listGateData(task.workflowRunId)
      .then((records) => {
        if (cancelled) return;
        // Pick the first rejected/waiting gate. Note: in multi-gate workflows
        // this may not be the gate that actually blocked the task. A future
        // improvement would store `blockingGateId` on SpaceTask to remove
        // ambiguity.
        const rejected = records.find(
          (r) => r.data?.approved === false || r.data?.waiting === true
        );
        if (rejected) {
          setPendingGate({ gateId: rejected.gateId, data: rejected.data });
        }
      })
      .catch(() => {
        // Gate data fetch is best-effort
      });
    return () => {
      cancelled = true;
    };
  }, [reason, task.workflowRunId]);

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

  // Human-input requests render the question body as a "Question" message in
  // the thread (space-task-thread-events.ts). Here we show only a thin hint
  // pointing users to the composer — enough to be a safety net if the thread
  // transformation is ever absent, without duplicating the full question.
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

  // If showing full gate review, render GateArtifactsView
  if (showGateReview && pendingGate && task.workflowRunId) {
    return (
      <GateArtifactsView
        runId={task.workflowRunId}
        gateId={pendingGate.gateId}
        spaceId={spaceId}
        gateData={pendingGate.data}
        onClose={() => setShowGateReview(false)}
        onDecision={() => setShowGateReview(false)}
      />
    );
  }

  const config = (reason && REASON_CONFIG[reason]) || FALLBACK_CONFIG;

  if (reason === 'gate_rejected' && pendingGate) {
    actions.unshift({
      label: 'Review & Approve',
      onClick: () => setShowGateReview(true),
      variant: 'secondary',
      testId: 'gate-review-btn',
    });
  }

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
        // Surface the reason text in a separate test hook so existing tests
        // that assert on `task-blocked-message` keep working. The visible
        // copy lives in the banner's `meta` slot; this element is the
        // a11y-linked, test-locatable duplicate.
        <span class="sr-only" data-testid="task-blocked-message">
          {result}
        </span>
      )}
    </>
  );
}
