import type {
  EvolutionEpisode,
  EvolutionLesson,
  TaskProposalStatus,
  EvolutionScopeKind,
  MetricDirection,
  EvolutionEvidenceListResponse,
  TaskProposal,
  MetricDefinition,
  EvidenceRef,
  MetricSnapshot,
  EvidenceQualityPreflight,
  EvolutionScope,
  SpaceGoal,
} from '@hyperneo/shared';
import { scoreEvolutionEvidenceQuality } from '@hyperneo/shared';

export type ScopeTab = 'overview' | 'evidence' | 'metrics' | 'lessons' | 'episodes';

export type ReviewAction =
  | { kind: 'episode'; id: string; status: EvolutionEpisode['status'] }
  | { kind: 'lesson'; id: string; status: EvolutionLesson['status'] }
  | { kind: 'proposal'; id: string; status: TaskProposalStatus };

export const SCOPE_KINDS: EvolutionScopeKind[] = [
  'mission',
  'project',
  'campaign',
  'workflow',
  'custom',
];

export const SCOPE_TABS: ScopeTab[] = ['overview', 'evidence', 'metrics', 'lessons', 'episodes'];

export const METRIC_DIRECTIONS: MetricDirection[] = ['increase', 'decrease', 'target', 'maintain'];

export const EPISODE_JUDGE_TIMEOUT_MS = 120000;

export const DEFAULT_COMPLETED_TASK_THRESHOLD = 10;

export const EVIDENCE_PAGE_SIZE = 50;

export function mergePreflightContext(
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

export interface MetricDefinitionDraft {
  key: string;
  label: string;
  direction: MetricDirection;
  unit: string;
  targetValue: string;
}

export interface SnapshotValueDraft {
  key: string;
  value: string;
}

export interface ProposalEditDraft {
  title: string;
  description: string;
  reason: string;
  priority: TaskProposal['priority'];
}

export interface RollupDraft {
  summary: string;
  nextSteps: string;
}

export function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

export function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}

export function formatScopeCount(count: number): string {
  return `${count} ${count === 1 ? 'scope' : 'scopes'}`;
}

export function formatDefinitionCount(count: number): string {
  return `${count} ${count === 1 ? 'definition' : 'definitions'}`;
}

export function parseMetricValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

export function buildMetricDefinitions(drafts: MetricDefinitionDraft[]): MetricDefinition[] {
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

export function createProposalDraft(proposal: TaskProposal): ProposalEditDraft {
  return {
    title: proposal.title,
    description: proposal.description,
    reason: proposal.reason,
    priority: proposal.priority,
  };
}

export function nextStepsFromText(value: string): string[] {
  return value
    .split('\n')
    .map((step) => step.trim())
    .filter(Boolean);
}

export function buildEvidenceQualityPreflight(
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

export function getGoal(scope: EvolutionScope | null, goals: SpaceGoal[]): SpaceGoal | null {
  if (!scope?.spaceGoalId) return null;
  return goals.find((goal) => goal.id === scope.spaceGoalId) ?? null;
}
