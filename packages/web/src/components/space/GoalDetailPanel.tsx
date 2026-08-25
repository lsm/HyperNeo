import type { SpaceGoal, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { navigateToSpaceTask } from '../../lib/router';
import { connectionState } from '../../lib/state';
import { spaceStore } from '../../lib/space-store';
import { getGoalStatusConfig } from '../../lib/goal-status';
import { getPriorityIndicatorTone } from '../../lib/priority-tokens';
import { toast } from '../../lib/toast';
import { InspectBadge, InspectPanel, InspectPanelHeader } from '../ui/InspectPanel';
import { SectionCard } from '../ui/SectionCard';
import { StatusBadge } from '../ui/StatusBadge';
import { SpaceGoalDialog } from './SpaceGoalDialog';
import {
  formatGoalMetricSnapshot,
  getGoalLastActivityAt,
  getRecurringGoalActivityStatus,
} from './goal-display-utils';

interface GoalDetailPanelProps {
  spaceId: string;
  navigationSpaceId?: string;
  goalId: string;
}

const TYPE_LABELS: Record<SpaceGoal['type'], string> = {
  one_shot: 'One-shot',
  measurable: 'Measurable',
  recurring: 'Recurring',
};

const DEGRADED_REASON_LABELS: Record<string, string> = {
  paused: 'paused',
  disabled: 'disabled',
  archived: 'archived',
  missing: 'deleted or missing',
};

function formatDate(ts: number | null): string {
  if (!ts) return 'None';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function GoalDetailPanel({ spaceId, navigationSpaceId, goalId }: GoalDetailPanelProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const [editing, setEditing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [ownerLoadFailed, setOwnerLoadFailed] = useState(false);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const goal =
    spaceStore.spaceId.value === spaceId
      ? (spaceStore.goals.value.find((item) => item.id === goalId) ?? null)
      : null;
  const tasks = spaceStore.spaceId.value === spaceId ? spaceStore.tasks.value : [];
  const owner =
    spaceStore.spaceId.value === spaceId ? (spaceStore.goalOwners.value.get(goalId) ?? null) : null;
  const agents = spaceStore.spaceId.value === spaceId ? spaceStore.longHorizonAgents.value : [];
  const agentsVersion = agents.map((item) => `${item.id}:${item.status}`).join('|');
  const goalIdRef = useRef(goalId);
  const spaceIdRef = useRef(spaceId);
  goalIdRef.current = goalId;
  spaceIdRef.current = spaceId;

  useEffect(() => {
    setOwnerLoadFailed(false);
    setOwnerBusy(false);
    setAssignOpen(false);
    setAssigneeId('');
  }, [spaceId, goalId]);

  useEffect(() => {
    if (owner) setOwnerLoadFailed(false);
  }, [owner]);

  useEffect(() => {
    let cancelled = false;
    spaceStore
      .fetchGoalOwner(goalId)
      .then(() => {
        if (!cancelled) setOwnerLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setOwnerLoadFailed(true);
      });
    if (spaceStore.longHorizonAgents.value.length === 0) {
      spaceStore.refreshLongHorizonAgents().catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [spaceId, goalId, agentsVersion, connectionState.value]);

  if (!goal) {
    return (
      <InspectPanel
        emptyState={
          <div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
            Goal not found
          </div>
        }
      />
    );
  }

  const linkedTasks = tasks
    .filter(
      (task) =>
        task.goalId === goal.id || task.id === goal.activeTaskId || task.id === goal.lastTaskId
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activityTask = linkedTasks[0] ?? null;
  const lastActivityAt = getGoalLastActivityAt(goal, activityTask);

  const runAction = async (action: 'pause' | 'resume' | 'archive' | 'trigger') => {
    setActionLoading(true);
    try {
      if (action === 'pause') await spaceStore.pauseGoal(goal.id);
      else if (action === 'resume') await spaceStore.resumeGoal(goal.id);
      else if (action === 'archive') await spaceStore.archiveGoal(goal.id);
      else {
        const result = await spaceStore.createImmediateGoalTask(goal.id);
        if (result.queued) toast.success('Next goal task queued');
        else toast.success('Goal task created');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Goal action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const agentLabel = (agentId: string): string => {
    const agent = agents.find((item: SpaceLongHorizonAgent) => item.id === agentId);
    return agent ? `${agent.displayName} (@${agent.handle})` : `${agentId} (not found)`;
  };

  const runOwnerAction = async (action: 'assign' | 'unassign') => {
    setOwnerBusy(true);
    const previousOwner = owner;
    const mutatedGoalId = goal.id;
    const mutatedSpaceId = spaceId;
    const stillViewing = () =>
      goalIdRef.current === mutatedGoalId && spaceIdRef.current === mutatedSpaceId;
    try {
      if (action === 'assign') {
        if (!assigneeId) return;
        await spaceStore.assignGoalOwner(goal.id, assigneeId);
        const replacedPrevious =
          (previousOwner?.action === 'resolved' || previousOwner?.action === 'degraded') &&
          previousOwner.owner.agentId !== assigneeId;
        if (replacedPrevious) {
          toast.success('Owner updated — previous owner superseded');
        } else {
          toast.success('Owner updated');
        }
      } else {
        const result = await spaceStore.unassignGoalOwner(goal.id);
        if (result.action === 'resolved' || result.action === 'degraded') {
          toast.success('Primary owner removed — another owner assignment remains');
        } else {
          toast.success('Owner cleared');
        }
      }
      if (stillViewing()) setOwnerLoadFailed(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Owner update failed');
    } finally {
      setOwnerBusy(false);
      if (stillViewing()) {
        setAssignOpen(false);
        setAssigneeId('');
      }
    }
  };

  const renderOwnerStatus = () => {
    if (ownerLoadFailed) {
      return <p class="text-sm text-red-300">Owner unavailable — refresh to retry.</p>;
    }
    if (!owner) {
      return <p class="text-sm text-gray-400">Loading owner…</p>;
    }
    if (owner.action === 'resolved' || owner.action === 'degraded') {
      const degraded = owner.action === 'degraded';
      return (
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <StatusBadge
              tone={degraded ? 'warning' : 'success'}
              label={degraded ? 'Degraded' : 'Owned'}
            />
            <span class={`text-sm ${degraded ? 'text-amber-200' : 'text-gray-200'}`}>
              {agentLabel(owner.owner.agentId)}
            </span>
          </div>
          {degraded && (
            <p class="text-xs text-amber-300/80">
              Owner is {DEGRADED_REASON_LABELS[owner.reason] ?? owner.reason} — reassign an active
              owner to restore ownership.
            </p>
          )}
          {owner.conflicts.length > 0 && (
            <p class="text-xs text-gray-400">
              Superseded owner assignments: {owner.conflicts.map((c) => c.agentId).join(', ')}
            </p>
          )}
        </div>
      );
    }
    if (owner.action === 'coordinator_fallback') {
      return (
        <div class="space-y-1">
          {(() => {
            const coordinator = agents.find(
              (item: SpaceLongHorizonAgent) => item.id === owner.coordinatorAgentId
            );
            if (!coordinator || coordinator.status !== 'active') {
              return (
                <div class="flex items-center gap-2">
                  <StatusBadge tone="warning" label="Unowned" />
                  <span class="text-sm text-amber-200">
                    Coordinator fallback unavailable — assign an owner to restore ownership.
                  </span>
                </div>
              );
            }
            return (
              <div class="flex items-center gap-2">
                <StatusBadge tone="neutral" label="Unowned" />
                <span class="text-sm text-gray-300">
                  Falls back to coordinator {agentLabel(owner.coordinatorAgentId)}
                </span>
              </div>
            );
          })()}
        </div>
      );
    }
    return (
      <div class="flex items-center gap-2">
        <StatusBadge tone="neutral" label="Unowned" />
        <span class="text-sm text-gray-400">No long-horizon agent owns this goal.</span>
      </div>
    );
  };

  return (
    <InspectPanel
      header={
        <InspectPanelHeader
          title={goal.title}
          actions={
            <button
              type="button"
              onClick={() => setEditing(true)}
              class="rounded-lg border border-dark-600 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-dark-800"
            >
              Edit
            </button>
          }
          badges={
            <>
              <StatusBadge
                tone={getGoalStatusConfig(goal.status).tone}
                label={getGoalStatusConfig(goal.status).label}
              />
              <InspectBadge class="border-dark-600 bg-dark-800/60 text-gray-300">
                {TYPE_LABELS[goal.type]}
              </InspectBadge>
              <InspectBadge tone={getPriorityIndicatorTone(goal.priority)}>
                {goal.priority} Priority
              </InspectBadge>
            </>
          }
        />
      }
    >
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div class="space-y-5">
          <section class="flex flex-wrap gap-2">
            {goal.status === 'active' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void runAction('pause')}
                class="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-1.5 text-xs font-medium text-amber-300 disabled:opacity-50"
              >
                Pause
              </button>
            )}
            {goal.status === 'paused' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void runAction('resume')}
                class="rounded-lg border border-green-800/40 bg-green-950/20 px-3 py-1.5 text-xs font-medium text-green-300 disabled:opacity-50"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              disabled={actionLoading || goal.status !== 'active'}
              onClick={() => void runAction('trigger')}
              class="rounded-lg border border-blue-800/40 bg-blue-950/20 px-3 py-1.5 text-xs font-medium text-blue-300 disabled:opacity-50"
            >
              Create task now
            </button>
            {goal.status !== 'archived' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void runAction('archive')}
                class="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-300 disabled:opacity-50"
              >
                Archive
              </button>
            )}
          </section>

          <SectionCard title="Summary">
            <p class="text-sm leading-6 text-gray-300">
              {goal.summary || goal.description || 'No summary yet.'}
            </p>
          </SectionCard>

          {goal.type === 'recurring' ? (
            <SectionCard title="Activity">
              <div class="space-y-2 text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-gray-400">Status</span>
                  <span class="capitalize text-gray-300">
                    {getRecurringGoalActivityStatus(goal, activityTask)}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-2">
                  <span class="text-gray-400">Last activity</span>
                  <span class="text-gray-300">{formatDate(lastActivityAt)}</span>
                </div>
                <div>
                  <div class="text-gray-400">Metric trajectory</div>
                  <div class="mt-1 text-gray-300">{formatGoalMetricSnapshot(goal, 4)}</div>
                </div>
              </div>
            </SectionCard>
          ) : (
            <SectionCard title="Progress">
              <div class="h-2 rounded-full bg-dark-700">
                <div
                  class="h-2 rounded-full bg-green-500"
                  style={{ width: `${Math.max(0, Math.min(100, goal.progress ?? 0))}%` }}
                />
              </div>
              <p class="text-xs text-gray-400">{goal.progress ?? 0}% complete</p>
            </SectionCard>
          )}

          <section class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div class="text-gray-400">Last check-in</div>
              <div class="mt-1 text-gray-300">{formatDate(goal.lastCheckInAt)}</div>
            </div>
            <div>
              <div class="text-gray-400">Next check-in</div>
              <div class="mt-1 text-gray-300">{formatDate(goal.nextCheckInAt)}</div>
            </div>
          </section>

          <SectionCard title="Owner">
            <div class="space-y-3">
              {renderOwnerStatus()}
              <div class="flex flex-wrap items-center gap-2">
                {!assignOpen ? (
                  <button
                    type="button"
                    disabled={ownerBusy}
                    onClick={() => setAssignOpen(true)}
                    class="rounded-lg border border-dark-600 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-dark-800 disabled:opacity-50"
                  >
                    {owner?.action === 'resolved' || owner?.action === 'degraded'
                      ? 'Change owner'
                      : 'Assign owner'}
                  </button>
                ) : (
                  <>
                    <select
                      value={assigneeId}
                      aria-label="New goal owner"
                      onChange={(e) => setAssigneeId((e.target as HTMLSelectElement).value)}
                      class="rounded-lg border border-dark-600 bg-dark-900 px-2 py-1.5 text-xs text-gray-200"
                    >
                      <option value="">Select an agent…</option>
                      {agents.map((agent: SpaceLongHorizonAgent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.displayName} (@{agent.handle})
                          {agent.status !== 'active' ? ` — ${agent.status}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={ownerBusy || !assigneeId}
                      onClick={() => void runOwnerAction('assign')}
                      class="rounded-lg border border-blue-800/40 bg-blue-950/20 px-3 py-1.5 text-xs font-medium text-blue-300 disabled:opacity-50"
                    >
                      Assign
                    </button>
                    <button
                      type="button"
                      disabled={ownerBusy}
                      onClick={() => {
                        setAssignOpen(false);
                        setAssigneeId('');
                      }}
                      class="rounded-lg border border-dark-600 px-3 py-1.5 text-xs font-medium text-gray-400 hover:bg-dark-800 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                )}
                {(owner?.action === 'resolved' || owner?.action === 'degraded') && !assignOpen && (
                  <button
                    type="button"
                    disabled={ownerBusy}
                    onClick={() => void runOwnerAction('unassign')}
                    class="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-300 disabled:opacity-50"
                  >
                    Unassign
                  </button>
                )}
              </div>
            </div>
          </SectionCard>

          {goal.nextSteps.length > 0 && (
            <SectionCard title="Next Steps">
              <ul class="space-y-2 text-sm text-gray-300">
                {goal.nextSteps.map((step) => (
                  <li key={step} class="rounded-md border border-dark-700 bg-dark-900/40 px-3 py-2">
                    {step}
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <SectionCard title="Linked Tasks">
            <div class="space-y-2">
              {linkedTasks.length === 0 ? (
                <p class="text-sm text-gray-400">No linked tasks yet.</p>
              ) : (
                linkedTasks.slice(0, 8).map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => navigateToSpaceTask(routeSpaceId, task.id)}
                    class="w-full rounded-md border border-dark-700 bg-dark-900/40 px-3 py-2 text-left hover:border-dark-600 hover:bg-dark-800/60"
                  >
                    <div class="truncate text-sm text-gray-200">{task.title}</div>
                    <div class="mt-1 font-mono text-[11px] text-gray-400">#{task.taskNumber}</div>
                  </button>
                ))
              )}
            </div>
          </SectionCard>
        </div>
        <SpaceGoalDialog
          isOpen={editing}
          goal={goal}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            spaceStore.upsertGoal(saved);
          }}
        />
      </div>
    </InspectPanel>
  );
}
