import type {
  SpaceGoal,
  EvolutionScope,
  EvolutionScopeKind,
  EvolutionScopeCreateResponse,
  MetricDirection,
  EvolutionScopeUpdateResponse,
  EvolutionScopeListResponse,
} from '@hyperneo/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { MetricDefinitionDraft, ScopeTab } from './space-forge-values.ts';
import type { WorkflowModelSelection } from './visual-editor/WorkflowModelSelect';
import {
  buildMetricDefinitions,
  SCOPE_KINDS,
  formatKind,
  METRIC_DIRECTIONS,
  getGoal,
  DEFAULT_COMPLETED_TASK_THRESHOLD,
  SCOPE_TABS,
  formatScopeCount,
  formatDefinitionCount,
} from './space-forge-values.ts';
import { toast } from '../../lib/toast';
import { Modal } from '../ui/Modal';
import { cn, getRelativeTime } from '../../lib/utils';
import { formControlClass, FORM_CONTROL_CLASS } from '../ui/FormField';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';
import { Button } from '../ui/Button';
import { InspectPanel, InspectPanelHeader, InspectBadge } from '../ui/InspectPanel';
import { OverviewTab } from './SpaceForgeOverview.tsx';
import { EvidenceTab } from './SpaceForgeEvidence.tsx';
import { MetricsTab } from './SpaceForgeMetrics.tsx';
import { ActiveLessonsTab } from './SpaceForgeLessons.tsx';
import { EpisodesTab } from './SpaceForgeEpisodes.tsx';
import { currentSpaceScopeIdSignal, rightPanelTargetSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';

interface SpaceForgeProps {
  spaceId: string;
}

interface ScopeCreateDialogProps {
  isOpen: boolean;
  spaceId: string;
  goals: SpaceGoal[];
  onClose: () => void;
  onCreated: (scope: EvolutionScope) => void;
}

function ScopeCreateDialog({ isOpen, spaceId, goals, onClose, onCreated }: ScopeCreateDialogProps) {
  const { request } = useMessageHub();
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [kind, setKind] = useState<EvolutionScopeKind>('project');
  const [spaceGoalId, setSpaceGoalId] = useState('');
  const [episodeJudgeModel, setEpisodeJudgeModel] = useState<string | undefined>(undefined);
  const [episodeJudgeProvider, setEpisodeJudgeProvider] = useState<string | undefined>(undefined);
  const [metrics, setMetrics] = useState<MetricDefinitionDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recurringGoals = goals.filter(
    (goal) => goal.type === 'recurring' && goal.status !== 'archived'
  );

  const reset = () => {
    setName('');
    setObjective('');
    setKind('project');
    setSpaceGoalId('');
    setEpisodeJudgeModel(undefined);
    setEpisodeJudgeProvider(undefined);
    setMetrics([]);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleEpisodeJudgeModelChange = (
    value: string | undefined,
    selection?: WorkflowModelSelection
  ) => {
    setEpisodeJudgeModel(value);
    setEpisodeJudgeProvider(selection?.provider);
  };

  const addMetric = () => {
    setMetrics((current) => [
      ...current,
      { key: '', label: '', direction: 'increase', unit: '', targetValue: '' },
    ]);
  };

  const updateMetric = (index: number, patch: Partial<MetricDefinitionDraft>) => {
    setMetrics((current) =>
      current.map((metric, metricIndex) =>
        metricIndex === index ? { ...metric, ...patch } : metric
      )
    );
  };

  const removeMetric = (index: number) => {
    setMetrics((current) => current.filter((_, metricIndex) => metricIndex !== index));
  };

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    const metricDefinitions = buildMetricDefinitions(metrics);
    const keys = metricDefinitions.map((metric) => metric.key);
    if (!name.trim()) {
      setError('Scope name is required');
      return;
    }
    if (!objective.trim()) {
      setError('Objective is required');
      return;
    }
    if (new Set(keys).size !== keys.length) {
      setError('Metric keys must be unique');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      const response = await request<EvolutionScopeCreateResponse>('evolution.scope.create', {
        params: {
          spaceId,
          kind,
          name: name.trim(),
          objective: objective.trim(),
          spaceGoalId: spaceGoalId || null,
          metricDefinitions,
          ...(episodeJudgeModel ? { policy: { episodeJudgeModel, episodeJudgeProvider } } : {}),
        },
      });
      toast.success(`Scope "${response.scope.name}" created`);
      onCreated(response.scope);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create scope');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Scope" size="lg">
      <form onSubmit={handleSubmit} class="space-y-4">
        {error && (
          <div class="rounded-lg border border-danger bg-danger/20 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div>
          <label class="mb-1.5 block text-sm font-medium text-fg-soft">Name</label>
          <input
            value={name}
            onInput={(event) => setName((event.target as HTMLInputElement).value)}
            placeholder="Improve code review loop"
            class={cn(formControlClass().replace('px-2.5', 'px-4').replace('py-1.5', 'py-2.5'))}
            autoFocus
          />
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-medium text-fg-soft">Kind</label>
            <select
              value={kind}
              onChange={(event) =>
                setKind((event.target as HTMLSelectElement).value as EvolutionScopeKind)
              }
              class={FORM_CONTROL_CLASS}
            >
              {SCOPE_KINDS.map((option) => (
                <option key={option} value={option}>
                  {formatKind(option)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium text-fg-soft">
              Linked recurring goal
            </label>
            <select
              aria-label="Linked recurring goal"
              value={spaceGoalId}
              onInput={(event) => setSpaceGoalId((event.target as HTMLSelectElement).value)}
              class={FORM_CONTROL_CLASS}
            >
              <option value="">None</option>
              {recurringGoals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium text-fg-soft">Objective</label>
          <textarea
            value={objective}
            onInput={(event) => setObjective((event.target as HTMLTextAreaElement).value)}
            placeholder="What should this scope prove or improve?"
            rows={3}
            class={cn(
              formControlClass().replace('px-2.5', 'px-4').replace('py-1.5', 'py-2.5'),
              'resize-none'
            )}
          />
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium text-fg-soft">Episode judge model</label>
          <WorkflowModelSelect
            value={episodeJudgeModel}
            provider={episodeJudgeProvider}
            onChange={handleEpisodeJudgeModelChange}
            testId="forge-scope-model-select"
            className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
          <p class="mt-1 text-xs text-fg-muted">
            Optional. Falls back to this Space&apos;s default model when unset.
          </p>
        </div>

        <div class="space-y-3 rounded-lg border border-line bg-fill-soft p-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-medium text-fg-soft">Metric definitions</h3>
              <p class="text-xs text-fg-muted">Optional keys tracked by snapshots.</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={addMetric}>
              Add metric
            </Button>
          </div>
          {metrics.length === 0 ? (
            <p class="text-xs text-fg-muted">No metrics yet.</p>
          ) : (
            <div class="space-y-2">
              {metrics.map((metric, index) => (
                <div key={index} class="grid gap-2 md:grid-cols-[1fr_1fr_120px_100px_80px_auto]">
                  <input
                    value={metric.key}
                    onInput={(event) =>
                      updateMetric(index, { key: (event.target as HTMLInputElement).value })
                    }
                    placeholder="key"
                    class={FORM_CONTROL_CLASS}
                  />
                  <input
                    value={metric.label}
                    onInput={(event) =>
                      updateMetric(index, { label: (event.target as HTMLInputElement).value })
                    }
                    placeholder="Label"
                    class={FORM_CONTROL_CLASS}
                  />
                  <select
                    value={metric.direction}
                    onChange={(event) =>
                      updateMetric(index, {
                        direction: (event.target as HTMLSelectElement).value as MetricDirection,
                      })
                    }
                    class={FORM_CONTROL_CLASS}
                  >
                    {METRIC_DIRECTIONS.map((direction) => (
                      <option key={direction} value={direction}>
                        {direction}
                      </option>
                    ))}
                  </select>
                  <input
                    value={metric.unit}
                    onInput={(event) =>
                      updateMetric(index, { unit: (event.target as HTMLInputElement).value })
                    }
                    placeholder="unit"
                    class={FORM_CONTROL_CLASS}
                  />
                  <input
                    value={metric.targetValue}
                    onInput={(event) =>
                      updateMetric(index, { targetValue: (event.target as HTMLInputElement).value })
                    }
                    placeholder="target"
                    class={FORM_CONTROL_CLASS}
                  />
                  <button
                    type="button"
                    onClick={() => removeMetric(index)}
                    class="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-fill-soft hover:text-danger-soft"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create scope'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ScopeDetail({
  scope,
  goals,
  onScopeUpdated,
}: {
  scope: EvolutionScope;
  goals: SpaceGoal[];
  onScopeUpdated: (scope: EvolutionScope) => void;
}) {
  const { request } = useMessageHub();
  const [tab, setTab] = useState<ScopeTab>('overview');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingJudgeModel, setSavingJudgeModel] = useState(false);
  const [savingCompletedTaskAutomation, setSavingCompletedTaskAutomation] = useState(false);
  const judgeModelRequestVersion = useRef(0);
  const completedTaskAutomationRequestVersion = useRef(0);
  const judgeModelScopeId = useRef(scope.id);
  const automationDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutomationUpdates = useRef<{ enabled?: boolean; threshold?: number }>({});
  const automationSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const goal = getGoal(scope, goals);

  useEffect(() => {
    if (judgeModelScopeId.current === scope.id) return;
    judgeModelScopeId.current = scope.id;
    judgeModelRequestVersion.current += 1;
    completedTaskAutomationRequestVersion.current += 1;
    setSavingJudgeModel(false);
    setSavingCompletedTaskAutomation(false);
    setSettingsError(null);
    if (automationDebounceRef.current) {
      clearTimeout(automationDebounceRef.current);
      automationDebounceRef.current = null;
    }
    pendingAutomationUpdates.current = {};
  }, [scope.id]);

  const handleJudgeModelChange = async (
    value: string | undefined,
    selection?: WorkflowModelSelection
  ) => {
    const version = ++judgeModelRequestVersion.current;
    try {
      if (judgeModelRequestVersion.current !== version) return;
      setSavingJudgeModel(true);
      setSettingsError(null);
      const patch: Partial<EvolutionScope['policy']> = {};
      if (value) {
        patch.episodeJudgeModel = value;
        patch.episodeJudgeProvider = selection?.provider;
      } else {
        patch.episodeJudgeModel = null as never;
        patch.episodeJudgeProvider = null as never;
      }
      const response = await request<EvolutionScopeUpdateResponse>('evolution.scope.update', {
        id: scope.id,
        params: { policyPatch: patch },
      });
      if (judgeModelRequestVersion.current !== version) return;
      if (response.scope) {
        onScopeUpdated(response.scope);
        toast.success(
          value ? 'Episode judge model updated' : 'Episode judge model override cleared'
        );
      }
    } catch (err) {
      if (judgeModelRequestVersion.current === version) {
        setSettingsError(err instanceof Error ? err.message : 'Failed to update judge model');
      }
    } finally {
      if (judgeModelRequestVersion.current === version) {
        setSavingJudgeModel(false);
      }
    }
  };

  const runCompletedTaskAutomationUpdate = async (
    version: number,
    updates: { enabled?: boolean; threshold?: number }
  ) => {
    const currentAutomation = scope.policy.automation ?? {};
    const patch: Partial<typeof currentAutomation> = {};
    if (updates.enabled !== undefined) {
      patch.completedTaskAutomationEnabled = updates.enabled;
      if (
        updates.enabled &&
        currentAutomation.completedTaskThreshold === undefined &&
        goal?.type !== 'recurring'
      ) {
        patch.completedTaskThreshold = DEFAULT_COMPLETED_TASK_THRESHOLD;
      }
    }
    if (updates.threshold !== undefined) {
      patch.completedTaskThreshold = updates.threshold;
    }
    const threshold =
      patch.completedTaskThreshold !== undefined
        ? patch.completedTaskThreshold
        : currentAutomation.completedTaskThreshold !== undefined
          ? currentAutomation.completedTaskThreshold
          : DEFAULT_COMPLETED_TASK_THRESHOLD;
    if (!Number.isInteger(threshold) || threshold <= 0) {
      setSavingCompletedTaskAutomation(false);
      setSettingsError('Completed-task threshold must be a positive integer');
      return;
    }
    try {
      if (completedTaskAutomationRequestVersion.current !== version) return;
      setSavingCompletedTaskAutomation(true);
      setSettingsError(null);
      const response = await request<EvolutionScopeUpdateResponse>('evolution.scope.update', {
        id: scope.id,
        params: { policyPatch: { automation: patch } },
      });
      if (completedTaskAutomationRequestVersion.current !== version) return;
      if (response.scope) {
        onScopeUpdated(response.scope);
        toast.success('Completed-task automation updated');
      }
    } catch (err) {
      if (completedTaskAutomationRequestVersion.current === version) {
        setSettingsError(
          err instanceof Error ? err.message : 'Failed to update completed-task automation'
        );
      }
    } finally {
      if (completedTaskAutomationRequestVersion.current === version) {
        setSavingCompletedTaskAutomation(false);
      }
    }
  };

  const handleCompletedTaskAutomationChange = (updates: {
    enabled?: boolean;
    threshold?: number;
  }) => {
    const version = ++completedTaskAutomationRequestVersion.current;
    if (automationDebounceRef.current) {
      clearTimeout(automationDebounceRef.current);
      automationDebounceRef.current = null;
    }
    pendingAutomationUpdates.current = { ...pendingAutomationUpdates.current, ...updates };
    if (updates.threshold !== undefined) {
      setSettingsError(null);
    }
    automationDebounceRef.current = setTimeout(() => {
      const merged = pendingAutomationUpdates.current;
      pendingAutomationUpdates.current = {};
      automationDebounceRef.current = null;
      automationSaveQueue.current = automationSaveQueue.current
        .then(() => runCompletedTaskAutomationUpdate(version, merged))
        .catch(() => runCompletedTaskAutomationUpdate(version, merged));
    }, 300);
  };

  const completedTaskAutomation = scope.policy.automation ?? {};
  const hasCompletedTaskThreshold = completedTaskAutomation.completedTaskThreshold !== undefined;
  const completedTaskAutomationEnabled =
    completedTaskAutomation.completedTaskAutomationEnabled !== false &&
    (goal?.type === 'recurring' || hasCompletedTaskThreshold);
  const completedTaskThreshold =
    completedTaskAutomation.completedTaskThreshold ?? DEFAULT_COMPLETED_TASK_THRESHOLD;

  return (
    <InspectPanel
      header={
        <InspectPanelHeader
          title={scope.name}
          badges={
            <>
              <InspectBadge tone="special">{formatKind(scope.kind)}</InspectBadge>
              {goal && <InspectBadge tone="info">{goal.title}</InspectBadge>}
            </>
          }
        />
      }
    >
      <div class="px-3 pb-3 pt-3">
        <div class="grid grid-cols-5 gap-1 rounded-lg border border-line bg-surface/70 p-1">
          {SCOPE_TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              class={cn(
                'min-w-0 rounded-md px-2 py-1.5 text-center text-xs font-medium capitalize transition-colors',
                tab === item
                  ? 'bg-fill-strong text-fg shadow-sm'
                  : 'text-fg-muted hover:bg-fill-soft hover:text-fg-soft'
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-5">
        {tab === 'overview' && (
          <OverviewTab
            scope={scope}
            goal={goal}
            savingJudgeModel={savingJudgeModel}
            settingsError={settingsError}
            handleJudgeModelChange={handleJudgeModelChange}
            completedTaskAutomationEnabled={completedTaskAutomationEnabled}
            savingCompletedTaskAutomation={savingCompletedTaskAutomation}
            handleCompletedTaskAutomationChange={handleCompletedTaskAutomationChange}
            completedTaskThreshold={completedTaskThreshold}
          />
        )}
        {tab === 'evidence' && <EvidenceTab scope={scope} />}
        {tab === 'metrics' && <MetricsTab scope={scope} />}
        {tab === 'lessons' && <ActiveLessonsTab scope={scope} />}
        {tab === 'episodes' && <EpisodesTab scope={scope} goal={goal} />}
      </div>
    </InspectPanel>
  );
}

export function SpaceForge({ spaceId }: SpaceForgeProps) {
  const { request } = useMessageHub();
  const [scopes, setScopes] = useState<EvolutionScope[]>([]);
  const selectedScopeId = currentSpaceScopeIdSignal.value;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const requestVersion = useRef(0);
  const localMutationVersion = useRef(0);
  const goals = spaceStore.spaceId.value === spaceId ? spaceStore.goals.value : [];

  const loadScopes = useCallback(async () => {
    const version = ++requestVersion.current;
    const mutationVersion = localMutationVersion.current;
    setScopes([]);
    setLoading(true);
    setError(null);
    try {
      const scopeResponse = await request<EvolutionScopeListResponse>('evolution.scope.list', {
        spaceId,
      });
      if (requestVersion.current !== version) {
        return;
      }
      if (spaceStore.spaceId.value === spaceId) {
        await spaceStore.listGoals({ includeArchived: false }).catch(() => []);
      }
      if (requestVersion.current !== version) {
        return;
      }
      const nextScopes = scopeResponse.scopes ?? [];
      if (localMutationVersion.current !== mutationVersion) {
        setScopes((current) => {
          const existingIds = new Set(current.map((scope) => scope.id));
          return [...current, ...nextScopes.filter((scope) => !existingIds.has(scope.id))];
        });
        return;
      }
      setScopes(nextScopes);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load scopes');
      }
    } finally {
      if (requestVersion.current === version) {
        setLoading(false);
      }
    }
  }, [request, spaceId]);

  useEffect(() => {
    loadScopes().catch(() => undefined);
  }, [loadScopes]);

  useEffect(() => {
    return () => {
      currentSpaceScopeIdSignal.value = null;
      if (rightPanelTargetSignal.value?.type === 'scope') rightPanelTargetSignal.value = null;
    };
  }, [spaceId]);

  useEffect(() => {
    if (selectedScopeId && scopes.some((scope) => scope.id === selectedScopeId)) return;
    currentSpaceScopeIdSignal.value = scopes[0]?.id ?? null;
  }, [scopes, selectedScopeId]);

  const openScope = (scopeId: string) => {
    currentSpaceScopeIdSignal.value = scopeId;
    rightPanelTargetSignal.value = { type: 'scope', spaceId, scopeId };
  };

  const handleCreated = (scope: EvolutionScope) => {
    localMutationVersion.current += 1;
    setScopes((current) => [scope, ...current]);
    openScope(scope.id);
  };

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex-1 overflow-y-auto">
        <div class="glass-content-container">
          <section
            class={cn(
              'mb-5 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6',
              'glass-surface'
            )}
            data-testid="space-forge-introduction"
            aria-label="Evolve workspace summary"
          >
            <div class="max-w-2xl">
              <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-warning-soft/80">
                <span class="h-1.5 w-1.5 rounded-full bg-warning" />
                Continuous evolution
              </div>
              <h2 class="mt-2 text-lg font-semibold tracking-tight text-fg">Evolution scopes</h2>
              <p class="mt-1 text-sm leading-5 text-fg-soft">
                {formatScopeCount(scopes.length)} collecting evidence, metrics, lessons, and
                follow-up tasks from recurring goals.
              </p>
            </div>
            <button type="button" onClick={() => setCreateOpen(true)} class="glass-primary-button">
              Create scope
            </button>
          </section>

          {error && (
            <div
              class={cn(
                'mb-5 rounded-2xl border border-danger-soft/20 p-4 text-sm text-danger-soft',
                'flat-surface'
              )}
            >
              {error}
            </div>
          )}
          {loading && scopes.length === 0 && (
            <div class={cn('rounded-2xl border p-6 text-sm text-fg-soft', 'flat-surface')}>
              Loading scopes...
            </div>
          )}
          {!loading && scopes.length === 0 && (
            <div class={cn('rounded-2xl border border-dashed p-10 text-center', 'flat-surface')}>
              <p class="text-sm font-medium text-fg-soft">No Evolution scopes yet.</p>
              <p class="mt-1 text-xs text-fg-muted">
                Create one from a recurring goal to track evidence, metrics, lessons, and follow-up
                tasks.
              </p>
              <div class="mt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setCreateOpen(true)}
                >
                  Create scope
                </Button>
              </div>
            </div>
          )}
          {scopes.length > 0 && (
            <div class="glass-selected-cyan grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(21rem,100%),1fr))]">
              {scopes.map((scope) => {
                const goal = getGoal(scope, goals);
                const selected = selectedScopeId === scope.id;
                return (
                  <button
                    key={scope.id}
                    type="button"
                    onClick={() => openScope(scope.id)}
                    aria-pressed={selected}
                    class={cn(
                      'group relative flex min-h-[12rem] w-full flex-col overflow-hidden rounded-2xl border border-line p-5 text-left transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/70',
                      'flat-surface',
                      selected ? 'glass-surface-selected' : 'flat-hover hover:-translate-y-0.5'
                    )}
                  >
                    <div class="min-w-0">
                      <h3 class="line-clamp-2 text-base font-semibold leading-6 tracking-tight text-fg">
                        {scope.name}
                      </h3>
                      <div class="mt-2.5 flex flex-wrap items-center gap-2">
                        <span class="rounded-full border border-cyan-300/25 bg-cyan-300/[0.08] px-2 py-0.5 text-[11px] font-medium text-info-soft">
                          {formatKind(scope.kind)}
                        </span>
                        <span class="rounded-full border border-line bg-fill-soft px-2 py-0.5 text-[11px] font-medium text-fg-soft">
                          {formatDefinitionCount(scope.metricDefinitions.length)}
                        </span>
                      </div>
                      <p class="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-fg-soft">
                        {scope.objective || 'No objective recorded yet'}
                      </p>
                    </div>
                    <div class="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs">
                      <div class="min-w-0">
                        <span class="block text-fg-faint">Goal</span>
                        <span class="mt-0.5 block truncate text-fg-soft">
                          {goal ? `Goal: ${goal.title}` : 'No linked goal'}
                        </span>
                      </div>
                      <div class="min-w-0">
                        <span class="block text-fg-faint">Updated</span>
                        <span class="mt-0.5 block text-fg-soft">
                          {getRelativeTime(scope.updatedAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ScopeCreateDialog
        isOpen={createOpen}
        spaceId={spaceId}
        goals={goals}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
