import type {
  EvidenceQualityPreflight,
  EvolutionEpisode,
  EvolutionEpisodeCreateResponse,
  EvolutionEpisodeReviewBundleResponse,
  EvolutionFinding,
  EvolutionFindingDomain,
  EvolutionLesson,
  EvolutionRollupApplyResponse,
  EvolutionTaskProposalCreateTaskResponse,
  EvolutionScope,
  EvolutionScopeCreateResponse,
  EvolutionScopeKind,
  EvolutionScopeListResponse,
  EvolutionScopeUpdateResponse,
  EvolutionEvidenceListResponse,
  EvolutionMetricSnapshotCreateResponse,
  EvolutionMetricSnapshotListResponse,
  EvidenceRef,
  MetricDefinition,
  MetricDirection,
  MetricSnapshot,
  MetricSnapshotValues,
  SpaceGoal,
  TaskProposal,
  TaskProposalStatus,
} from '@hyperneo/shared';
import { scoreEvolutionEvidenceQuality } from '@hyperneo/shared';
import type { ComponentChild } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useMessageHub } from '../../hooks/useMessageHub';
import { currentSpaceScopeIdSignal, rightPanelTargetSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { cn, getRelativeTime } from '../../lib/utils';
import { Button } from '../ui/Button';
import { InspectBadge, InspectPanel, InspectPanelHeader } from '../ui/InspectPanel';
import { Modal } from '../ui/Modal';
import { SectionCard } from '../ui/SectionCard';
import { formatGoalMetricSnapshot } from './goal-display-utils';
import {
  WorkflowModelSelect,
  type WorkflowModelSelection,
} from './visual-editor/WorkflowModelSelect';

type ScopeTab = 'overview' | 'evidence' | 'metrics' | 'lessons' | 'episodes';

type ReviewAction =
  | { kind: 'episode'; id: string; status: EvolutionEpisode['status'] }
  | { kind: 'lesson'; id: string; status: EvolutionLesson['status'] }
  | { kind: 'proposal'; id: string; status: TaskProposalStatus };

const SCOPE_KINDS: EvolutionScopeKind[] = ['mission', 'project', 'campaign', 'workflow', 'custom'];
const SCOPE_TABS: ScopeTab[] = ['overview', 'evidence', 'metrics', 'lessons', 'episodes'];
const METRIC_DIRECTIONS: MetricDirection[] = ['increase', 'decrease', 'target', 'maintain'];
const EPISODE_JUDGE_TIMEOUT_MS = 120000;
const DEFAULT_COMPLETED_TASK_THRESHOLD = 10;
const EVIDENCE_PAGE_SIZE = 50;

function mergePreflightContext(
  a: EvolutionEvidenceListResponse['preflightContext'],
  b: EvolutionEvidenceListResponse['preflightContext']
): EvolutionEvidenceListResponse['preflightContext'] {
  if (!a) return b;
  if (!b) return a;
  const runsById = new Map(a.workflowRuns.map((entry) => [entry.run.id, entry]));
  for (const entry of b.workflowRuns) {
    const existing = runsById.get(entry.run.id);
    if (existing) {
      runsById.set(entry.run.id, {
        ...existing,
        evidenceIds: Array.from(new Set([...existing.evidenceIds, ...entry.evidenceIds])),
      });
    } else {
      runsById.set(entry.run.id, entry);
    }
  }
  return { tasks: [...a.tasks, ...b.tasks], workflowRuns: [...runsById.values()] };
}

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

interface MetricDefinitionDraft {
  key: string;
  label: string;
  direction: MetricDirection;
  unit: string;
  targetValue: string;
}

interface SnapshotValueDraft {
  key: string;
  value: string;
}

interface ProposalEditDraft {
  title: string;
  description: string;
  reason: string;
  priority: TaskProposal['priority'];
}

interface RollupDraft {
  summary: string;
  nextSteps: string;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}

function formatScopeCount(count: number): string {
  return `${count} ${count === 1 ? 'scope' : 'scopes'}`;
}

function formatDefinitionCount(count: number): string {
  return `${count} ${count === 1 ? 'definition' : 'definitions'}`;
}

function parseMetricValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

function buildMetricDefinitions(drafts: MetricDefinitionDraft[]): MetricDefinition[] {
  return drafts
    .map((draft) => ({
      key: draft.key.trim(),
      label: draft.label.trim(),
      direction: draft.direction,
      unit: draft.unit.trim() || undefined,
      targetValue: draft.targetValue.trim() ? parseMetricValue(draft.targetValue) : undefined,
    }))
    .filter((metric) => metric.key && metric.label);
}

function createProposalDraft(proposal: TaskProposal): ProposalEditDraft {
  return {
    title: proposal.title,
    description: proposal.description,
    reason: proposal.reason,
    priority: proposal.priority,
  };
}

function nextStepsFromText(value: string): string[] {
  return value
    .split('\n')
    .map((step) => step.trim())
    .filter(Boolean);
}

function buildEvidenceQualityPreflight(
  evidence: EvidenceRef[],
  selectedEvidenceIds: string[],
  metricSnapshots: MetricSnapshot[] = [],
  preflightContext?: EvolutionEvidenceListResponse['preflightContext']
): EvidenceQualityPreflight | null {
  if (selectedEvidenceIds.length === 0) return null;
  const selected = evidence.filter((item) => selectedEvidenceIds.includes(item.id));
  if (selected.length === 0) return null;
  const selectedIds = new Set(selected.map((item) => item.id));
  return scoreEvolutionEvidenceQuality({
    evidence: selected,
    availableScopeEvidence: evidence,
    tasks: (preflightContext?.tasks ?? [])
      .filter((item) => selectedIds.has(item.evidenceId))
      .map(({ task }) => task),
    workflowRuns: (preflightContext?.workflowRuns ?? [])
      .filter((item) => item.evidenceIds.some((id) => selectedIds.has(id)))
      .map(({ run, tasks, artifacts }) => ({
        run,
        tasks,
        artifacts: artifacts.map((artifact) => ({
          type: artifact.artifactType,
          key: artifact.artifactKey,
          data: artifact.data,
        })),
      })),
    metricSnapshotCount: metricSnapshots.length,
  });
}

function getGoal(scope: EvolutionScope | null, goals: SpaceGoal[]): SpaceGoal | null {
  if (!scope?.spaceGoalId) return null;
  return goals.find((goal) => goal.id === scope.spaceGoalId) ?? null;
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
            class="w-full rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
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
              class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
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
              class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
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
            class="w-full resize-none rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
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
                    class="rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
                  />
                  <input
                    value={metric.label}
                    onInput={(event) =>
                      updateMetric(index, { label: (event.target as HTMLInputElement).value })
                    }
                    placeholder="Label"
                    class="rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
                  />
                  <select
                    value={metric.direction}
                    onChange={(event) =>
                      updateMetric(index, {
                        direction: (event.target as HTMLSelectElement).value as MetricDirection,
                      })
                    }
                    class="rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
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
                    class="rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
                  />
                  <input
                    value={metric.targetValue}
                    onInput={(event) =>
                      updateMetric(index, { targetValue: (event.target as HTMLInputElement).value })
                    }
                    placeholder="target"
                    class="rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
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

function GoalSummary({ goal }: { goal: SpaceGoal }) {
  return (
    <div class="rounded-lg border border-accent/20 bg-accent/5 p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-wide text-accent-soft">
            Linked recurring goal
          </p>
          <h3 class="mt-1 text-sm font-medium text-fg">{goal.title}</h3>
        </div>
        <span class="rounded-full bg-accent/10 px-2 py-1 text-xs text-accent-soft">Metrics</span>
      </div>
      <p class="mb-3 text-xs text-accent-soft/80">
        Metric trajectory: {formatGoalMetricSnapshot(goal)}
      </p>
      {goal.summary && <p class="text-sm text-fg-soft">{goal.summary}</p>}
      {goal.nextSteps.length > 0 && (
        <ul class="mt-3 space-y-1 text-xs text-fg-muted">
          {goal.nextSteps.map((step) => (
            <li key={step}>Next: {step}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceTab({ scope }: { scope: EvolutionScope }) {
  const { request } = useMessageHub();
  const [evidence, setEvidence] = useState<EvidenceRef[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadEvidence = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
        scopeId: scope.id,
        limit: EVIDENCE_PAGE_SIZE,
        offset: 0,
      });
      if (requestVersion.current === version) {
        setEvidence(response.evidence ?? []);
        setExhausted((response.evidence ?? []).length < EVIDENCE_PAGE_SIZE);
      }
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load evidence');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  useEffect(() => {
    loadEvidence().catch(() => undefined);
  }, [loadEvidence]);

  const loadMoreEvidence = async () => {
    if (loadingMore || exhausted) return;
    const version = ++requestVersion.current;
    setLoadingMore(true);
    try {
      const response = await request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
        scopeId: scope.id,
        limit: EVIDENCE_PAGE_SIZE,
        offset: evidence.length,
      });
      if (requestVersion.current !== version) return;
      const next = response.evidence ?? [];
      setEvidence((current) => [...current, ...next]);
      setExhausted(next.length < EVIDENCE_PAGE_SIZE);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load more evidence');
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const handleAddNote = async (event: Event) => {
    event.preventDefault();
    if (!note.trim()) return;
    try {
      setSubmitting(true);
      setError(null);
      await request<{ evidence: EvidenceRef }>('evolution.evidence.addManualNote', {
        scopeId: scope.id,
        summary: note.trim(),
      });
      setNote('');
      await loadEvidence();
      toast.success('Evidence note attached');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attach note');
    } finally {
      setSubmitting(false);
    }
  };

  const timeline = [...evidence].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div class="space-y-4">
      <form onSubmit={handleAddNote} class="rounded-xl border border-line bg-fill-soft p-4">
        <label class="mb-2 block text-sm font-medium text-fg-soft">Attach manual note</label>
        <textarea
          value={note}
          onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
          placeholder="What happened? What evidence should Evolve remember?"
          rows={3}
          class="w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
        />
        <div class="mt-3 flex justify-end">
          <Button type="submit" size="sm" disabled={submitting || !note.trim()}>
            {submitting ? 'Attaching…' : 'Attach note'}
          </Button>
        </div>
      </form>

      {error && (
        <div class="rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-medium text-fg">Evidence timeline</h3>
          <span class="text-xs text-fg-muted">{timeline.length} items</span>
        </div>
        {loading ? (
          <p class="text-sm text-fg-muted">Loading evidence…</p>
        ) : timeline.length === 0 ? (
          <div class="text-sm text-fg-muted">
            <p>No evidence attached yet.</p>
            <p class="mt-1 text-xs text-fg-muted">
              Attach a completed task, metric snapshot, or manual note before generating an episode.
            </p>
          </div>
        ) : (
          <div class="space-y-3">
            {timeline.map((item) => (
              <div key={item.id} class="rounded-lg border border-line bg-surface/60 p-3">
                <div class="mb-1 flex items-center justify-between gap-3">
                  <span class="rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-soft">
                    {formatKind(item.kind)}
                  </span>
                  <span class="text-xs text-fg-muted">{formatDate(item.createdAt)}</span>
                </div>
                <p class="text-sm text-fg-soft">{item.summary}</p>
              </div>
            ))}
            {!exhausted && (
              <div class="pt-1">
                <Button variant="ghost" size="sm" onClick={loadMoreEvidence} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more evidence'}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function EpisodesTab({ scope, goal }: { scope: EvolutionScope; goal: SpaceGoal | null }) {
  const { request } = useMessageHub();
  const [episodes, setEpisodes] = useState<EvolutionEpisode[]>([]);
  const [lessons, setLessons] = useState<EvolutionLesson[]>([]);
  const [proposals, setProposals] = useState<TaskProposal[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRef[]>([]);
  const [preflightContext, setPreflightContext] =
    useState<EvolutionEvidenceListResponse['preflightContext']>();
  const [evidenceExhausted, setEvidenceExhausted] = useState(false);
  const [loadingMoreEvidence, setLoadingMoreEvidence] = useState(false);
  const [metricSnapshots, setMetricSnapshots] = useState<MetricSnapshot[]>([]);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [confirmLowConfidence, setConfirmLowConfidence] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [proposalDraft, setProposalDraft] = useState<ProposalEditDraft | null>(null);
  const [rollupDraft, setRollupDraft] = useState<RollupDraft>({
    summary: goal?.summary ?? '',
    nextSteps: goal?.nextSteps.join('\n') ?? '',
  });
  const requestVersion = useRef(0);

  const loadReview = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const metricSnapshotsPromise = request<EvolutionMetricSnapshotListResponse>(
        'evolution.metricSnapshot.list',
        { scopeId: scope.id }
      ).catch(() => ({ snapshots: [] }));
      const [reviewResponse, evidenceResponse, metricResponse] = await Promise.all([
        request<EvolutionEpisodeReviewBundleResponse>('evolution.review.get', {
          scopeId: scope.id,
          limit: EVIDENCE_PAGE_SIZE,
        }),
        request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
          scopeId: scope.id,
          includePreflightContext: true,
          limit: EVIDENCE_PAGE_SIZE,
          offset: 0,
        }),
        metricSnapshotsPromise,
      ]);
      if (requestVersion.current !== version) return;
      setEpisodes(reviewResponse.episodes ?? []);
      setLessons(reviewResponse.lessons ?? []);
      setProposals(reviewResponse.proposals ?? []);
      setEvidence(evidenceResponse.evidence ?? []);
      setPreflightContext(evidenceResponse.preflightContext);
      setEvidenceExhausted((evidenceResponse.evidence ?? []).length < EVIDENCE_PAGE_SIZE);
      setMetricSnapshots(metricResponse.snapshots ?? []);
      setSelectedEvidenceIds((current) =>
        current.filter((id) => evidenceResponse.evidence.some((item) => item.id === id))
      );
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load episode review');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  const loadMoreEvidence = async () => {
    if (loadingMoreEvidence || evidenceExhausted) return;
    const version = ++requestVersion.current;
    setLoadingMoreEvidence(true);
    try {
      const response = await request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
        scopeId: scope.id,
        includePreflightContext: true,
        limit: EVIDENCE_PAGE_SIZE,
        offset: evidence.length,
      });
      if (requestVersion.current !== version) return;
      const next = response.evidence ?? [];
      setEvidence((current) => [...current, ...next]);
      setPreflightContext((current) => mergePreflightContext(current, response.preflightContext));
      setEvidenceExhausted(next.length < EVIDENCE_PAGE_SIZE);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load more evidence');
      }
    } finally {
      setLoadingMoreEvidence(false);
    }
  };

  useEffect(() => {
    setSelectedEvidenceIds([]);
    loadReview().catch(() => undefined);
  }, [loadReview]);

  useEffect(() => {
    setRollupDraft({
      summary: goal?.summary ?? '',
      nextSteps: goal?.nextSteps.join('\n') ?? '',
    });
  }, [goal]);

  const latestEpisode = episodes[0] ?? null;
  const groupedFindings = useMemo(
    () => groupFindingsByDomain(latestEpisode?.findings ?? []),
    [latestEpisode]
  );
  const frictionFindings = (latestEpisode?.findings ?? []).filter(
    (finding) => finding.kind === 'friction'
  );
  const candidateLessons = lessons.filter((lesson) => lesson.status === 'candidate');
  const proposedTasks = proposals.filter((proposal) => proposal.status === 'proposed');
  const canApplyRollup =
    !!goal &&
    !!latestEpisode &&
    latestEpisode.status !== 'dismissed' &&
    latestEpisode.rollupAppliedAt === null;
  const preflight = useMemo(
    () =>
      buildEvidenceQualityPreflight(
        evidence,
        selectedEvidenceIds,
        metricSnapshots,
        preflightContext
      ),
    [evidence, metricSnapshots, preflightContext, selectedEvidenceIds]
  );
  const preflightReady = preflight?.requiresConfirmation ? confirmLowConfidence : true;

  const toggleEvidence = (id: string) => {
    setConfirmLowConfidence(false);
    setSelectedEvidenceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const handleCreateEpisode = async () => {
    if (selectedEvidenceIds.length === 0) {
      setError('Select at least one evidence item');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const response = await request<EvolutionEpisodeCreateResponse>(
        'evolution.episode.createFromEvidence',
        {
          scopeId: scope.id,
          evidenceIds: selectedEvidenceIds,
          confirmLowConfidence: confirmLowConfidence || undefined,
        },
        { timeout: EPISODE_JUDGE_TIMEOUT_MS }
      );
      setEpisodes((current) => [response.episode, ...current]);
      setLessons((current) => [...(response.lessons ?? []), ...current]);
      setProposals((current) => [...(response.proposals ?? []), ...current]);
      setSelectedEvidenceIds([]);
      setConfirmLowConfidence(false);
      toast.success(`Episode "${response.episode.title}" drafted`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create episode');
    } finally {
      setSubmitting(false);
    }
  };

  const updateReviewItem = async (action: ReviewAction) => {
    try {
      setError(null);
      if (action.kind === 'episode') {
        const response = await request<{ episode: EvolutionEpisode | null }>(
          'evolution.episode.update',
          {
            id: action.id,
            params: { status: action.status },
          }
        );
        if (response.episode) {
          setEpisodes((current) =>
            current.map((item) => (item.id === response.episode?.id ? response.episode : item))
          );
        }
      } else if (action.kind === 'lesson') {
        const response = await request<{ lesson: EvolutionLesson | null }>(
          'evolution.lesson.update',
          {
            id: action.id,
            params: { status: action.status },
          }
        );
        if (response.lesson) {
          setLessons((current) =>
            current.map((item) => (item.id === response.lesson?.id ? response.lesson : item))
          );
        }
      } else {
        const response = await request<{ proposal: TaskProposal | null }>(
          'evolution.taskProposal.update',
          {
            id: action.id,
            params: { status: action.status },
          }
        );
        if (response.proposal) {
          setProposals((current) =>
            current.map((item) => (item.id === response.proposal?.id ? response.proposal : item))
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update review item');
    }
  };

  const createTaskFromProposal = async (proposal: TaskProposal, draft?: ProposalEditDraft) => {
    try {
      setSubmitting(true);
      setError(null);
      const response = await request<EvolutionTaskProposalCreateTaskResponse>(
        'evolution.taskProposal.createTask',
        {
          id: proposal.id,
          params: draft
            ? {
                title: draft.title,
                description: draft.description,
                reason: draft.reason,
                priority: draft.priority,
              }
            : undefined,
        }
      );
      setProposals((current) =>
        current.map((item) => (item.id === response.proposal.id ? response.proposal : item))
      );
      setEditingProposalId(null);
      setProposalDraft(null);
      toast.success(`Task #${response.task.taskNumber} created`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task from proposal');
    } finally {
      setSubmitting(false);
    }
  };

  const beginEditProposal = (proposal: TaskProposal) => {
    setEditingProposalId(proposal.id);
    setProposalDraft(createProposalDraft(proposal));
  };

  const applyRollup = async () => {
    if (!latestEpisode || !goal) return;
    try {
      setSubmitting(true);
      setError(null);
      const response = await request<EvolutionRollupApplyResponse>('evolution.rollup.apply', {
        episodeId: latestEpisode.id,
        goalUpdate: {
          summary: rollupDraft.summary.trim(),
          nextSteps: nextStepsFromText(rollupDraft.nextSteps),
        },
      });
      setEpisodes((current) =>
        current.map((item) => (item.id === response.episode.id ? response.episode : item))
      );
      if (spaceStore.spaceId.value === response.goal.spaceId) {
        spaceStore.upsertGoal(response.goal);
      }
      toast.success(`Rollup applied to "${response.goal.title}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply rollup');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="space-y-4">
      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 class="text-sm font-medium text-fg">Generate episode draft</h3>
            <p class="mt-1 text-xs text-fg-muted">
              Select scoped evidence. Judge creates draft only; lessons and proposals remain
              candidates.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleCreateEpisode}
            disabled={submitting || selectedEvidenceIds.length === 0 || !preflightReady}
          >
            {submitting ? 'Judging…' : 'Create episode'}
          </Button>
        </div>
        {evidence.length === 0 ? (
          <div class="text-sm text-fg-muted">
            <p>No evidence available.</p>
            <p class="mt-1 text-xs text-fg-muted">
              Add evidence from the Evidence or Metrics tab, then return here to draft an episode.
            </p>
          </div>
        ) : (
          <div class="space-y-3">
            <div class="grid gap-2 md:grid-cols-2">
              {evidence.map((item) => (
                <label
                  key={item.id}
                  class="flex gap-3 rounded-lg border border-line bg-surface/60 p-3 text-sm text-fg-soft"
                >
                  <input
                    type="checkbox"
                    checked={selectedEvidenceIds.includes(item.id)}
                    onChange={() => toggleEvidence(item.id)}
                    class="mt-1"
                  />
                  <span>
                    <span class="mb-1 block text-xs text-info-soft">{formatKind(item.kind)}</span>
                    {item.summary}
                  </span>
                </label>
              ))}
            </div>
            {!evidenceExhausted && (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMoreEvidence}
                  disabled={loadingMoreEvidence}
                >
                  {loadingMoreEvidence ? 'Loading…' : 'Load more evidence'}
                </Button>
              </div>
            )}
            {preflight && (
              <div
                class={`rounded-lg border px-3 py-2 text-sm ${
                  preflight.level === 'high'
                    ? 'border-success/30 bg-success/10 text-success-soft'
                    : preflight.level === 'medium'
                      ? 'border-warning/30 bg-warning/10 text-warning-soft'
                      : 'border-danger/30 bg-danger/10 text-danger-soft'
                }`}
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium">Evidence preflight: {preflight.level} confidence</span>
                  <span class="text-xs opacity-80">
                    {preflight.score}/{preflight.maxScore} · {preflight.counts.total} selected
                  </span>
                </div>
                {preflight.reasons.length > 0 && (
                  <ul class="mt-2 list-disc space-y-1 pl-5 text-xs opacity-90">
                    {preflight.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                {preflight.warnings.length > 0 && (
                  <ul class="mt-2 list-disc space-y-1 pl-5 text-xs opacity-90">
                    {preflight.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
                {preflight.artifactDiagnostics &&
                  preflight.artifactDiagnostics.status !== 'selected' &&
                  preflight.artifactDiagnostics.recommendations.length > 0 && (
                    <div class="mt-2 rounded-md border border-line bg-scrim-soft px-2 py-1.5 text-xs">
                      <div class="font-medium">
                        Artifact selection: {preflight.artifactDiagnostics.status.replace('_', ' ')}
                        {preflight.artifactDiagnostics.availableKinds.length > 0 &&
                          ` · kinds: ${preflight.artifactDiagnostics.availableKinds.join(', ')}`}
                      </div>
                      <ul class="mt-1 list-disc space-y-1 pl-5 opacity-90">
                        {preflight.artifactDiagnostics.recommendations.map((rec) => (
                          <li key={rec}>{rec}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                {preflight.requiresConfirmation && (
                  <label class="mt-3 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={confirmLowConfidence}
                      onChange={(event) =>
                        setConfirmLowConfidence((event.currentTarget as HTMLInputElement).checked)
                      }
                    />
                    Generate low-confidence episode anyway
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {error && (
        <div class="rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <p class="text-sm text-fg-muted">Loading review…</p>
      ) : !latestEpisode ? (
        <div class="rounded-xl border border-line bg-fill-soft p-4 text-sm text-fg-muted">
          <p>No episode drafts yet.</p>
          <p class="mt-1 text-xs text-fg-muted">
            Select scoped evidence above to generate candidate lessons and next action proposals.
          </p>
        </div>
      ) : (
        <div class="space-y-4">
          <section class="rounded-xl border border-line bg-fill-soft p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-wide text-fg-muted">Outcome summary</p>
                <h3 class="mt-1 text-base font-semibold text-fg">{latestEpisode.title}</h3>
              </div>
              <span class="rounded-full bg-fill-soft px-2 py-1 text-xs text-fg-soft">
                {latestEpisode.status}
              </span>
            </div>
            <p class="mt-3 text-sm text-fg-soft">{latestEpisode.outcomeSummary}</p>
            <div class="mt-4 flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  updateReviewItem({ kind: 'episode', id: latestEpisode.id, status: 'accepted' })
                }
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  updateReviewItem({ kind: 'episode', id: latestEpisode.id, status: 'dismissed' })
                }
              >
                Dismiss
              </Button>
            </div>
          </section>

          {canApplyRollup && (
            <section class="rounded-xl border border-accent/20 bg-accent/5 p-4">
              <p class="text-sm font-medium text-accent-soft">Manual rollup writeback</p>
              <p class="mt-1 text-xs text-accent-soft/70">
                Apply accepted episode state to linked recurring goal.
              </p>
              <div class="mt-3">
                <textarea
                  aria-label="Rollup summary"
                  value={rollupDraft.summary}
                  onInput={(event) =>
                    setRollupDraft((current) => ({
                      ...current,
                      summary: (event.target as HTMLTextAreaElement).value,
                    }))
                  }
                  placeholder="Goal summary after this rollup"
                  rows={3}
                  class="w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
                />
              </div>
              <textarea
                aria-label="Rollup next steps"
                value={rollupDraft.nextSteps}
                onInput={(event) =>
                  setRollupDraft((current) => ({
                    ...current,
                    nextSteps: (event.target as HTMLTextAreaElement).value,
                  }))
                }
                placeholder="One next step per line"
                rows={2}
                class="mt-3 w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
              />
              <div class="mt-3 flex justify-end">
                <Button size="sm" onClick={applyRollup} disabled={submitting}>
                  Apply rollup
                </Button>
              </div>
            </section>
          )}

          <section class="rounded-xl border border-line bg-fill-soft p-4">
            <h3 class="mb-3 text-sm font-medium text-fg">Findings by domain</h3>
            <div class="space-y-3">
              {Object.entries(groupedFindings).map(([domain, findings]) => (
                <div key={domain} class="rounded-lg border border-line bg-surface/60 p-3">
                  <h4 class="mb-2 text-sm font-medium text-info-soft">{formatKind(domain)}</h4>
                  <div class="space-y-2">
                    {findings.map((finding, index) => (
                      <FindingCard key={`${domain}-${index}`} finding={finding} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section class="rounded-xl border border-orange-500/20 bg-warning/5 p-4">
            <h3 class="mb-3 text-sm font-medium text-warning-soft">HyperNeo friction findings</h3>
            {frictionFindings.length === 0 ? (
              <p class="text-sm text-warning-soft/70">No friction findings in latest episode.</p>
            ) : (
              <div class="space-y-2">
                {frictionFindings.map((finding, index) => (
                  <FindingCard key={`friction-${index}`} finding={finding} />
                ))}
              </div>
            )}
          </section>

          <div class="grid gap-4 lg:grid-cols-2">
            <ReviewList
              title="Candidate lessons"
              empty="No candidate lessons."
              items={candidateLessons}
              render={(lesson) => (
                <div key={lesson.id} class="rounded-lg border border-line bg-surface/60 p-3">
                  <p class="text-sm text-fg">{lesson.rule}</p>
                  <p class="mt-1 text-xs text-fg-muted">{lesson.why}</p>
                  <div class="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        updateReviewItem({ kind: 'lesson', id: lesson.id, status: 'active' })
                      }
                    >
                      Activate
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        updateReviewItem({ kind: 'lesson', id: lesson.id, status: 'dismissed' })
                      }
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}
            />
            <ReviewList
              title="Next action proposals"
              empty="No proposed actions."
              items={proposedTasks}
              render={(proposal) => {
                const editing = editingProposalId === proposal.id && proposalDraft;
                return (
                  <div key={proposal.id} class="rounded-lg border border-line bg-surface/60 p-3">
                    {editing ? (
                      <div class="space-y-2">
                        <input
                          aria-label="Proposal title"
                          value={proposalDraft.title}
                          onInput={(event) =>
                            setProposalDraft((current) =>
                              current
                                ? { ...current, title: (event.target as HTMLInputElement).value }
                                : current
                            )
                          }
                          class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                        />
                        <textarea
                          aria-label="Proposal description"
                          value={proposalDraft.description}
                          onInput={(event) =>
                            setProposalDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    description: (event.target as HTMLTextAreaElement).value,
                                  }
                                : current
                            )
                          }
                          rows={2}
                          class="w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                        />
                        <textarea
                          aria-label="Proposal reason"
                          value={proposalDraft.reason}
                          onInput={(event) =>
                            setProposalDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    reason: (event.target as HTMLTextAreaElement).value,
                                  }
                                : current
                            )
                          }
                          rows={2}
                          class="w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                        />
                        <select
                          aria-label="Proposal priority"
                          value={proposalDraft.priority}
                          onChange={(event) =>
                            setProposalDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    priority: (event.target as HTMLSelectElement)
                                      .value as TaskProposal['priority'],
                                  }
                                : current
                            )
                          }
                          class="rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
                        >
                          {(['low', 'normal', 'high', 'urgent'] as const).map((priority) => (
                            <option key={priority} value={priority}>
                              {priority}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <>
                        <div class="flex items-start justify-between gap-2">
                          <p class="text-sm font-medium text-fg">{proposal.title}</p>
                          <span class="rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-muted">
                            {proposal.priority}
                          </span>
                        </div>
                        <p class="mt-1 text-xs text-fg-muted">{proposal.description}</p>
                        <p class="mt-2 text-xs text-fg-muted">Reason: {proposal.reason}</p>
                      </>
                    )}
                    <div class="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => createTaskFromProposal(proposal)}
                        disabled={submitting}
                      >
                        Create Task
                      </Button>
                      {editing ? (
                        <Button
                          size="sm"
                          onClick={() => createTaskFromProposal(proposal, proposalDraft)}
                          disabled={submitting || !proposalDraft.title.trim()}
                        >
                          Save & Create
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => beginEditProposal(proposal)}
                        >
                          Edit & Create
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateReviewItem({
                            kind: 'proposal',
                            id: proposal.id,
                            status: 'dismissed',
                          })
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                );
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveLessonsTab({ scope }: { scope: EvolutionScope }) {
  const { request } = useMessageHub();
  const [lessons, setLessons] = useState<EvolutionLesson[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadLessons = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await request<{ lessons: EvolutionLesson[] }>('evolution.lesson.list', {
        scopeId: scope.id,
        status: 'active',
      });
      if (requestVersion.current === version) setLessons(response.lessons ?? []);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load active lessons');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  useEffect(() => {
    loadLessons().catch(() => undefined);
  }, [loadLessons]);

  const dismissLesson = async (lessonId: string) => {
    try {
      setError(null);
      const response = await request<{ lesson: EvolutionLesson | null }>(
        'evolution.lesson.update',
        {
          id: lessonId,
          params: { status: 'dismissed' },
        }
      );
      if (response.lesson) setLessons((current) => current.filter((item) => item.id !== lessonId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss lesson');
    }
  };

  return (
    <section class="rounded-xl border border-line bg-fill-soft p-4">
      <div class="mb-3">
        <h3 class="text-sm font-medium text-fg">Active lessons</h3>
        <p class="mt-1 text-xs text-fg-muted">
          Top active lessons from this scope are injected into future scoped task-agent messages.
        </p>
      </div>
      {error && (
        <div class="mb-3 rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {loading ? (
        <p class="text-sm text-fg-muted">Loading active lessons…</p>
      ) : lessons.length === 0 ? (
        <p class="text-sm text-fg-muted">No active lessons yet.</p>
      ) : (
        <div class="space-y-3">
          {lessons.map((lesson) => (
            <div key={lesson.id} class="rounded-lg border border-line bg-surface/60 p-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm text-fg">{lesson.rule}</p>
                  <p class="mt-1 text-xs text-fg-muted">{lesson.why}</p>
                  {lesson.appliesTo.length > 0 && (
                    <p class="mt-2 text-xs text-info-soft">
                      Applies to: {lesson.appliesTo.join(', ')}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => dismissLesson(lesson.id)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FindingCard({ finding }: { finding: EvolutionFinding }) {
  return (
    <div class="rounded-md border border-line bg-scrim-soft p-3">
      <div class="mb-2 flex flex-wrap gap-2">
        <span class="rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-soft">
          {formatKind(finding.kind)}
        </span>
        <span class="rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-soft">
          {finding.impact} impact
        </span>
        <span class="rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-soft">
          {Math.round(finding.confidence * 100)}% confidence
        </span>
      </div>
      <p class="text-sm text-fg-soft">{finding.proposedAction}</p>
      {finding.evidence.length > 0 && (
        <p class="mt-2 text-xs text-fg-muted">Evidence: {finding.evidence.join(', ')}</p>
      )}
    </div>
  );
}

function ReviewList<T>({
  title,
  empty,
  items,
  render,
}: {
  title: string;
  empty: string;
  items: T[];
  render: (item: T) => ComponentChild;
}) {
  return (
    <section class="rounded-xl border border-line bg-fill-soft p-4">
      <h3 class="mb-3 text-sm font-medium text-fg">{title}</h3>
      {items.length === 0 ? (
        <p class="text-sm text-fg-muted">{empty}</p>
      ) : (
        <div class="space-y-3">{items.map(render)}</div>
      )}
    </section>
  );
}

function groupFindingsByDomain(
  findings: EvolutionFinding[]
): Record<EvolutionFindingDomain, EvolutionFinding[]> {
  return {
    workflow: findings.filter((finding) => finding.domain === 'workflow'),
    target_artifact: findings.filter((finding) => finding.domain === 'target_artifact'),
    hyperneo_product: findings.filter((finding) => finding.domain === 'hyperneo_product'),
  };
}

function MetricsTab({ scope }: { scope: EvolutionScope }) {
  const { request } = useMessageHub();
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
  const [values, setValues] = useState<SnapshotValueDraft[]>(
    scope.metricDefinitions.map((metric) => ({ key: metric.key, value: '' }))
  );
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadSnapshots = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await request<EvolutionMetricSnapshotListResponse>(
        'evolution.metricSnapshot.list',
        {
          scopeId: scope.id,
        }
      );
      if (requestVersion.current === version) setSnapshots(response.snapshots ?? []);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load metric snapshots');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  useEffect(() => {
    setValues(scope.metricDefinitions.map((metric) => ({ key: metric.key, value: '' })));
    loadSnapshots().catch(() => undefined);
  }, [loadSnapshots, scope.metricDefinitions]);

  const updateValue = (index: number, value: string) => {
    setValues((current) =>
      current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, value } : entry))
    );
  };

  const handleAddSnapshot = async (event: Event) => {
    event.preventDefault();
    const snapshotValues = values.reduce<MetricSnapshotValues>((acc, entry) => {
      if (entry.value.trim()) acc[entry.key] = parseMetricValue(entry.value);
      return acc;
    }, {});
    if (Object.keys(snapshotValues).length === 0) {
      setError('At least one metric value is required');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await request<EvolutionMetricSnapshotCreateResponse>('evolution.metricSnapshot.create', {
        params: {
          scopeId: scope.id,
          values: snapshotValues,
          source: 'manual',
          note: note.trim() || null,
        },
      });
      setValues((current) => current.map((entry) => ({ ...entry, value: '' })));
      setNote('');
      await loadSnapshots();
      toast.success('Metric snapshot added');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add metric snapshot');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="space-y-4">
      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <h3 class="mb-3 text-sm font-medium text-fg">Metric definitions</h3>
        {scope.metricDefinitions.length === 0 ? (
          <p class="text-sm text-fg-muted">No metric definitions for this scope.</p>
        ) : (
          <div class="grid gap-3 md:grid-cols-2">
            {scope.metricDefinitions.map((metric) => (
              <div key={metric.key} class="rounded-lg border border-line bg-surface/60 p-3">
                <div class="flex items-center justify-between gap-3">
                  <p class="text-sm font-medium text-fg">{metric.label}</p>
                  <span class="text-xs text-fg-muted">{metric.direction}</span>
                </div>
                <p class="mt-1 text-xs text-fg-muted">
                  {metric.key}
                  {metric.unit ? ` · ${metric.unit}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {scope.metricDefinitions.length > 0 && (
        <form onSubmit={handleAddSnapshot} class="rounded-xl border border-line bg-fill-soft p-4">
          <h3 class="mb-3 text-sm font-medium text-fg">Add metric snapshot</h3>
          <div class="grid gap-3 md:grid-cols-2">
            {values.map((entry, index) => {
              const metric = scope.metricDefinitions.find(
                (definition) => definition.key === entry.key
              );
              return (
                <label key={entry.key} class="block">
                  <span class="mb-1 block text-xs text-fg-muted">{metric?.label ?? entry.key}</span>
                  <input
                    value={entry.value}
                    onInput={(event) =>
                      updateValue(index, (event.target as HTMLInputElement).value)
                    }
                    placeholder={metric?.unit ?? 'value'}
                    class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
                  />
                </label>
              );
            })}
          </div>
          <textarea
            value={note}
            onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
            placeholder="Optional snapshot note"
            rows={2}
            class="mt-3 w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
          />
          <div class="mt-3 flex justify-end">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add snapshot'}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <div class="rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <h3 class="mb-3 text-sm font-medium text-fg">Snapshot history</h3>
        {loading ? (
          <p class="text-sm text-fg-muted">Loading snapshots…</p>
        ) : snapshots.length === 0 ? (
          <p class="text-sm text-fg-muted">No metric snapshots yet.</p>
        ) : (
          <div class="space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} class="rounded-lg border border-line bg-surface/60 p-3">
                <div class="mb-2 flex items-center justify-between gap-3">
                  <span class="text-sm text-fg-soft">{snapshot.source}</span>
                  <span class="text-xs text-fg-muted">{formatDate(snapshot.capturedAt)}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  {Object.entries(snapshot.values).map(([key, value]) => (
                    <span
                      key={key}
                      class="rounded-full bg-fill-soft px-2 py-1 text-xs text-fg-soft"
                    >
                      {key}: {String(value)}
                    </span>
                  ))}
                </div>
                {snapshot.note && <p class="mt-2 text-sm text-fg-muted">{snapshot.note}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
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
          <div class="space-y-4">
            {scope.objective && (
              <p class="px-1 text-sm leading-5 text-fg-muted">{scope.objective}</p>
            )}
            {goal ? (
              <GoalSummary goal={goal} />
            ) : (
              <div class="rounded-lg border border-line bg-fill-soft p-4 text-sm text-fg-muted">
                No recurring goal linked.
              </div>
            )}
            <div class="grid gap-3 md:grid-cols-2">
              <div class="rounded-lg border border-line bg-fill-soft p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  Created
                </p>
                <p class="mt-1 text-sm text-fg-soft">{getRelativeTime(scope.createdAt)}</p>
              </div>
              <div class="rounded-lg border border-line bg-fill-soft p-4">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  Metrics
                </p>
                <p class="mt-1 text-sm text-fg-soft">
                  {formatDefinitionCount(scope.metricDefinitions.length)}
                </p>
              </div>
            </div>
            <SectionCard title="Episode judge model">
              <p class="text-xs text-fg-muted">
                Override model for episode judging, or clear to use Space default.
              </p>
              <WorkflowModelSelect
                value={
                  typeof scope.policy.episodeJudgeModel === 'string'
                    ? scope.policy.episodeJudgeModel
                    : undefined
                }
                provider={
                  typeof scope.policy.episodeJudgeProvider === 'string'
                    ? scope.policy.episodeJudgeProvider
                    : undefined
                }
                onChange={handleJudgeModelChange}
                testId="scope-episode-judge-model-select"
                className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
              />
              {savingJudgeModel && <p class="text-xs text-fg-muted">Saving…</p>}
              {settingsError && <p class="text-xs text-danger">{settingsError}</p>}
            </SectionCard>
            {goal && (
              <SectionCard title="Completed-task automation">
                <p class="text-xs text-fg-muted">
                  Draft an Evolution episode after a configured number of completed scoped tasks.
                </p>
                <label class="flex items-center gap-2 text-sm text-fg-soft">
                  <input
                    type="checkbox"
                    checked={completedTaskAutomationEnabled}
                    disabled={savingCompletedTaskAutomation}
                    onChange={(event) =>
                      handleCompletedTaskAutomationChange({
                        enabled: (event.currentTarget as HTMLInputElement).checked,
                      })
                    }
                    class="h-4 w-4 rounded border-line-strong bg-surface-raised text-accent focus:ring-accent"
                  />
                  Enable count-based episode drafts
                </label>
                <label class="mt-3 block text-xs font-medium uppercase tracking-wide text-fg-muted">
                  Completed task threshold
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={completedTaskThreshold}
                    disabled={!completedTaskAutomationEnabled || savingCompletedTaskAutomation}
                    onChange={(event) =>
                      handleCompletedTaskAutomationChange({
                        threshold: Number((event.currentTarget as HTMLInputElement).value),
                      })
                    }
                    data-testid="scope-completed-task-threshold-input"
                    class="mt-1 w-32 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                </label>
                {savingCompletedTaskAutomation && <p class="text-xs text-fg-muted">Saving…</p>}
              </SectionCard>
            )}
          </div>
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
            <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(21rem,100%),1fr))]">
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
                      selected
                        ? '!border-[rgba(111,177,255,0.72)] bg-[linear-gradient(145deg,rgba(35,82,137,0.44),rgba(13,20,32,0.96)_62%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_20px_48px_rgba(0,0,0,0.3)]'
                        : 'hover:-translate-y-0.5 hover:bg-surface-overlay/95'
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
