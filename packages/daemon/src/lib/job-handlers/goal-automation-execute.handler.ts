import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import type {
  EvidenceQualityPreflight,
  EvidenceRef,
  GoalForgeAutomationTriggerKind,
  SpaceGoal,
  SpaceTask,
} from '@hyperneo/shared';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { GoalAutomationCursorRepository } from '../../storage/repositories/goal-automation-cursor-repository';
import type { SpaceGoalEventRepository } from '../../storage/repositories/space-goal-event-repository';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { EvolutionEpisodeService } from '../space/evolution-episode-service';
import {
  maxCompletedTaskTimestamp,
  maxEvidenceCursor,
  readAutomationPolicyForScope,
  readCompletedTaskThreshold,
  selectEvidenceAfterCursor,
} from '../space/goals/goal-automation-service';
import { GOAL_AUTOMATION_EXECUTE } from '../job-queue-constants';
import { Logger } from '../logger';

const log = new Logger('goal-automation-execute');
const MAX_ACTIVE_REVIEW_REQUEUES = 60;
const EXTENDED_REQUEUE_DELAY_MS = 300_000;
const activeAutomationLocks = new Set<string>();

function automationLockKey(payload: GoalAutomationExecutePayload): string {
  return `${payload.goalId}:${payload.scopeId}:${payload.triggerKind}`;
}

export interface GoalAutomationExternalEventSnapshot {
  source: string;
  topic: string;
  summary: string;
  externalUrl?: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  ingestedAt: number;
}

export interface GoalAutomationExecutePayload extends Record<string, unknown> {
  goalId: string;
  scopeId: string;
  triggerKind: GoalForgeAutomationTriggerKind;
  triggerKey: string;
  reason: 'task_completed' | 'self_nag' | 'external_event';
  taskId?: string;
  scheduleId?: string;
  externalEventId?: string;
  externalEvent?: GoalAutomationExternalEventSnapshot;
  activeReviewRequeueCount?: number;
}

export interface GoalAutomationExecuteDeps {
  db?: BunDatabase;
  goalRepo: SpaceGoalRepository;
  taskRepo: SpaceTaskRepository;
  evolutionRepo: EvolutionRepository;
  cursorRepo: GoalAutomationCursorRepository;
  episodeService: Pick<EvolutionEpisodeService, 'createFromEvidence'> & {
    /**
     * Optional evidence-quality preflight. When wired, self_nag ticks skip the
     * episode judge + review task on thin, process-level evidence and record a
     * no-op note on the goal instead. Production always wires this.
     */
    preflightEvidence?: (params: {
      scopeId: string;
      evidenceIds: string[];
    }) => EvidenceQualityPreflight;
  };
  goalEventRepo?: Pick<SpaceGoalEventRepository, 'create'>;
  taskCreatedEventHub?: {
    publish: (event: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  jobQueue?: Pick<JobQueueRepository, 'enqueueUniquePending'>;
}

export interface GoalAutomationExecuteResult extends Record<string, unknown> {
  goalId: string;
  scopeId: string;
  episodeId: string | null;
  reviewTaskId: string | null;
  evidenceCount: number;
  skipped: boolean;
  skipReason?:
    | 'missing_goal'
    | 'inactive_goal'
    | 'missing_scope'
    | 'no_evidence'
    | 'below_threshold'
    | 'active_review'
    | 'disabled'
    | 'low_evidence_noop';
  requeued?: boolean;
}

export async function handleGoalAutomationExecute(
  job: Job,
  deps: GoalAutomationExecuteDeps
): Promise<GoalAutomationExecuteResult> {
  const payload = validatePayload(job.payload);
  const goal = deps.goalRepo.getById(payload.goalId);
  if (!goal) return skipped(payload, 'missing_goal');
  if (goal.status !== 'active') return skipped(payload, 'inactive_goal');
  const scope = deps.evolutionRepo.getScope(payload.scopeId);
  if (!scope || scope.spaceGoalId !== goal.id || scope.spaceId !== goal.spaceId) {
    return skipped(payload, 'missing_scope');
  }
  if (payload.externalEvent) {
    ensureExternalEventEvidence(deps, payload, scope.id);
  }
  const cursor =
    payload.triggerKind === 'completed_task_threshold'
      ? newestCursor(
          deps.cursorRepo.get(goal.id, scope.id, payload.triggerKind, payload.triggerKey),
          deps.cursorRepo.getLatestForTriggerKind(goal.id, scope.id, 'completed_task_threshold')
        )
      : deps.cursorRepo.get(goal.id, scope.id, payload.triggerKind, payload.triggerKey);
  const policy = readAutomationPolicyForScope(scope);
  const maxEvidence = readMaxEvidence(policy.maxEvidencePerEpisode);
  const dueEvidence = selectEvidenceAfterCursor(
    deps.evolutionRepo.listEvidence(scope.id),
    cursor?.lastEvidenceCreatedAt ?? null,
    Number.POSITIVE_INFINITY,
    cursor?.lastEvidenceId ?? null
  );
  const evidence = dueEvidence.slice(0, maxEvidence);
  const triggerEvidence = findTriggerEvidence(dueEvidence, payload);
  if (evidence.length === 0) {
    return skipped(payload, 'no_evidence');
  }
  if (payload.triggerKind === 'completed_task_threshold') {
    if (goal.type !== 'recurring' && policy.completedTaskThreshold === undefined) {
      return skipped(payload, 'disabled');
    }
    const threshold = readCompletedTaskThreshold(policy);
    const completedTaskIds = new Set(
      dueEvidence
        .filter((item) => item.kind === 'task_result' && item.sourceId !== null)
        .map((item) => item.sourceId as string)
    );
    if (!threshold || completedTaskIds.size < threshold) {
      return skipped(payload, 'below_threshold', dueEvidence.length);
    }
    if (findActiveCompletedTaskReviewTask(deps, scope.id, payload)) {
      return requeueActiveReview(deps, payload, dueEvidence.length);
    }
    const lock = automationLockKey(payload);
    if (activeAutomationLocks.has(lock)) {
      return requeueActiveReview(deps, payload, dueEvidence.length);
    }
    activeAutomationLocks.add(lock);
  }

  // self_nag: skip no-op episodes on thin, process-level evidence. When the
  // selection carries no substantive signal — no affirmative outcome (a PR
  // reference, merge/pass/fail/quantitative result, or deploy verb with a
  // concrete artifact reference — not a negated, pending, or prospective
  // mention like "CI has not run yet" or "tests will pass") and every row is
  // thin (a manual note or an auto-generated session trace diagnostic marked
  // `metadata.traceDiagnostic`) — record a lightweight no-op note on the goal
  // and advance the cursor without spending an episode-judge call or creating
  // a review task. The selection-aware content test decides (the preflight
  // score can be inflated by scope-wide metrics or loose keyword outcomes);
  // the preflight is computed only on the skip path for the audit note, so
  // substantive ticks don't pay a duplicate buildEpisodeInput. Substantive
  // manual notes, genuine session summaries, and any task result, friction
  // trace, artifact, error, or in-batch metric still produces an episode.
  // Honors the goal guardrail: "if evidence is insufficient, finish without
  // inventing work." (#919)
  if (payload.triggerKind === 'self_nag' && deps.episodeService.preflightEvidence) {
    if (shouldSkipSelfNagNoOp(evidence)) {
      const preflight = deps.episodeService.preflightEvidence({
        scopeId: scope.id,
        evidenceIds: evidence.map((item) => item.id),
      });
      runWriteTransaction(deps, () => {
        recordSelfNagNoOpNote(deps, goal, preflight);
        advanceCursor(deps, payload, evidence, goal.spaceId, null, {
          skipReason: 'low_evidence_noop',
        });
      });
      return {
        goalId: goal.id,
        scopeId: scope.id,
        episodeId: null,
        reviewTaskId: null,
        evidenceCount: evidence.length,
        skipped: true,
        skipReason: 'low_evidence_noop',
      };
    }
  }

  try {
    let episodeEvidence = evidence;
    if (triggerEvidence && payload.triggerKind === 'completed_task_threshold') {
      const triggerIndex = dueEvidence.findIndex((item) => item.id === triggerEvidence.id);
      if (triggerIndex >= maxEvidence) {
        episodeEvidence = dueEvidence.slice(0, triggerIndex + 1);
      } else {
        episodeEvidence = uniqueEvidence([...evidence, triggerEvidence]);
      }
    } else if (triggerEvidence && payload.triggerKind === 'external_event') {
      episodeEvidence = uniqueEvidence([...evidence, triggerEvidence]);
    }
    const cursorEvidence =
      triggerEvidence && payload.triggerKind === 'completed_task_threshold'
        ? episodeEvidence
        : evidence;
    const existingAutomation = findExistingAutomationReviewTask(deps, scope.id, payload);
    if (existingAutomation) {
      advanceCursor(
        deps,
        payload,
        cursorEvidence,
        existingAutomation.reviewTask.spaceId,
        existingAutomation.episodeId,
        { reviewTaskId: existingAutomation.reviewTask.id }
      );
      return {
        goalId: goal.id,
        scopeId: scope.id,
        episodeId: existingAutomation.episodeId,
        reviewTaskId: existingAutomation.reviewTask.id,
        evidenceCount: episodeEvidence.length,
        skipped: false,
      };
    }

    const episodeResult = await deps.episodeService.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: episodeEvidence.map((item) => item.id),
      confirmLowConfidence: true,
    });
    const writeResult = runWriteTransaction(deps, () => {
      const reviewTask = createReviewTask(
        deps,
        goal.id,
        scope.id,
        episodeResult.episode.id,
        episodeEvidence,
        payload
      );
      advanceCursor(deps, payload, cursorEvidence, reviewTask.spaceId, episodeResult.episode.id, {
        reviewTaskId: reviewTask.id,
      });
      return reviewTask;
    });
    const reviewTask = writeResult;
    emitTaskCreated(deps, reviewTask);
    return {
      goalId: goal.id,
      scopeId: scope.id,
      episodeId: episodeResult.episode.id,
      reviewTaskId: reviewTask.id,
      evidenceCount: evidence.length,
      skipped: false,
    };
  } finally {
    if (payload.triggerKind === 'completed_task_threshold') {
      activeAutomationLocks.delete(automationLockKey(payload));
    }
  }
}

function newestCursor<
  T extends {
    lastEvidenceCreatedAt: number | null;
    lastEvidenceId: string | null;
    updatedAt: number;
  },
>(first: T | null, second: T | null): T | null {
  if (!first) return second;
  if (!second) return first;
  const firstEvidence = first.lastEvidenceCreatedAt ?? 0;
  const secondEvidence = second.lastEvidenceCreatedAt ?? 0;
  if (firstEvidence !== secondEvidence) return firstEvidence > secondEvidence ? first : second;
  const firstEvidenceId = first.lastEvidenceId ?? '';
  const secondEvidenceId = second.lastEvidenceId ?? '';
  if (firstEvidenceId !== secondEvidenceId) {
    return firstEvidenceId.localeCompare(secondEvidenceId) >= 0 ? first : second;
  }
  return first.updatedAt >= second.updatedAt ? first : second;
}

function findTriggerEvidence(
  dueEvidence: EvidenceRef[],
  payload: GoalAutomationExecutePayload
): EvidenceRef | null {
  if (payload.triggerKind === 'external_event' && payload.externalEventId) {
    return dueEvidence.find((item) => item.sourceId === payload.externalEventId) ?? null;
  }
  if (payload.triggerKind === 'completed_task_threshold' && payload.taskId) {
    return (
      dueEvidence.find((item) => item.kind === 'task_result' && item.sourceId === payload.taskId) ??
      null
    );
  }
  return null;
}

function uniqueEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function ensureExternalEventEvidence(
  deps: GoalAutomationExecuteDeps,
  payload: GoalAutomationExecutePayload,
  scopeId: string
): EvidenceRef | null {
  if (!payload.externalEvent || !payload.externalEventId) return null;
  const existing = deps.evolutionRepo
    .listEvidence(scopeId)
    .find(
      (item) =>
        item.kind === 'manual_note' &&
        item.sourceId === payload.externalEventId &&
        item.metadata.autoCaptured === true &&
        item.metadata.triggerKind === payload.triggerKind
    );
  if (existing) return existing;
  return runWriteTransaction(deps, () =>
    deps.evolutionRepo.createEvidence({
      scopeId,
      kind: 'manual_note',
      sourceId: payload.externalEventId as string,
      summary: `External event: ${payload.externalEvent?.summary}`,
      metadata: {
        autoCaptured: true,
        triggerKind: payload.triggerKind,
        source: payload.externalEvent?.source,
        topic: payload.externalEvent?.topic,
        externalUrl: payload.externalEvent?.externalUrl ?? null,
        payload: payload.externalEvent?.payload ?? {},
      },
      createdAt: payload.externalEvent?.ingestedAt ?? Date.now(),
    })
  );
}

function runWriteTransaction<T>(deps: GoalAutomationExecuteDeps, fn: () => T): T {
  return deps.db ? deps.db.transaction(fn)() : fn();
}

function createReviewTask(
  deps: GoalAutomationExecuteDeps,
  goalId: string,
  scopeId: string,
  episodeId: string,
  evidence: EvidenceRef[],
  payload: GoalAutomationExecutePayload
): SpaceTask {
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) throw new Error(`EvolutionScope not found: ${scopeId}`);
  return deps.taskRepo.createTask({
    spaceId: scope.spaceId,
    goalId,
    evolutionScopeId: scopeId,
    title: `Review Evolution retrospective: ${scope.name}`,
    description: [
      'Evolve generated a draft retrospective episode from automation-selected evidence.',
      `Episode: ${episodeId}`,
      `Automation trigger: ${automationTriggerToken(payload)}`,
      `Evidence selected:\n${evidence.map((item) => `- ${item.id}: ${item.summary}`).join('\n')}`,
      'Review candidate lessons and task proposals before accepting or creating follow-up work.',
    ].join('\n\n'),
    priority: 'normal',
    labels: ['forge', 'review', 'automation', automationTriggerToken(payload)],
  });
}

function findActiveCompletedTaskReviewTask(
  deps: GoalAutomationExecuteDeps,
  scopeId: string,
  _payload: GoalAutomationExecutePayload
): SpaceTask | null {
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) return null;
  return (
    deps.taskRepo.listBySpace(scope.spaceId, true).find((task) => {
      if (task.evolutionScopeId !== scopeId) return false;
      if (!task.labels.includes('automation')) return false;
      if (!task.labels.some((label) => label.startsWith('automation:completed_task_threshold:'))) {
        return false;
      }
      return [
        'draft',
        'open',
        'in_progress',
        'review',
        'approved',
        'blocked',
        // A review task paused on a rate/usage cap is still the active review —
        // it auto-resumes when the cap lifts. Excluding it would let a later
        // threshold job create a duplicate review task + episode.
        'rate_limited',
        'usage_limited',
      ].includes(task.status);
    }) ?? null
  );
}

function findExistingAutomationReviewTask(
  deps: GoalAutomationExecuteDeps,
  scopeId: string,
  payload: GoalAutomationExecutePayload
): { reviewTask: SpaceTask; episodeId: string } | null {
  const scope = deps.evolutionRepo.getScope(scopeId);
  if (!scope) return null;
  const token = automationTriggerToken(payload);
  // For self-nag, the token is stable across ticks (same scheduleId).
  // Only reuse a task if it was created in the current automation run
  // (after the cursor's lastFiredAt). This prevents cross-tick dedup
  // while still protecting against retry duplication within a tick.
  const cursor =
    payload.triggerKind === 'completed_task_threshold'
      ? newestCursor(
          deps.cursorRepo.get(payload.goalId, scopeId, payload.triggerKind, payload.triggerKey),
          deps.cursorRepo.getLatestForTriggerKind(
            payload.goalId,
            scopeId,
            'completed_task_threshold'
          )
        )
      : deps.cursorRepo.get(payload.goalId, scopeId, payload.triggerKind, payload.triggerKey);
  const afterTimestamp = cursor?.lastFiredAt ?? 0;
  const task = deps.taskRepo.listBySpace(scope.spaceId, true).find((item) => {
    if (item.evolutionScopeId !== scopeId) return false;
    if (!item.labels.includes('automation') || !item.labels.includes(token)) return false;
    // For self-nag and completed_task_threshold, only match tasks created
    // after the last cursor fire. This prevents reusing terminal review
    // tasks when the same trigger fires again for newer evidence.
    if (
      (payload.triggerKind === 'self_nag' || payload.triggerKind === 'completed_task_threshold') &&
      item.createdAt <= afterTimestamp
    ) {
      return false;
    }
    return true;
  });
  if (!task) return null;
  const match = task.description.match(/Episode: ([^\n]+)/);
  const episodeId = match?.[1]?.trim();
  return episodeId ? { reviewTask: task, episodeId } : null;
}

function automationTriggerToken(payload: GoalAutomationExecutePayload): string {
  return `automation:${payload.triggerKind}:${payload.triggerKey}:${payload.externalEventId ?? payload.taskId ?? payload.scheduleId ?? 'run'}`;
}

function advanceCursor(
  deps: GoalAutomationExecuteDeps,
  payload: GoalAutomationExecutePayload,
  evidence: EvidenceRef[],
  spaceId: string,
  episodeId: string | null,
  context: { reviewTaskId?: string | null; skipReason?: string } = {}
): void {
  const taskIds = new Set(evidence.flatMap((item) => (item.sourceId ? [item.sourceId] : [])));
  const tasks = Array.from(taskIds).flatMap((taskId) => {
    const task = deps.taskRepo.getTask(taskId);
    return task ? [task] : [];
  });
  const evidenceCursor = maxEvidenceCursor(evidence);
  deps.cursorRepo.upsert({
    spaceId,
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    triggerKind: payload.triggerKind,
    triggerKey: payload.triggerKey,
    lastEvidenceCreatedAt: evidenceCursor?.createdAt ?? null,
    lastEvidenceId: evidenceCursor?.id ?? null,
    lastTaskCompletedAt: maxCompletedTaskTimestamp(tasks),
    lastExternalEventId: payload.externalEventId ?? null,
    lastEpisodeId: episodeId,
    lastFiredAt: Date.now(),
    metadata: {
      reason: payload.reason,
      reviewTaskId: context.reviewTaskId ?? null,
      evidenceIds: evidence.map((item) => item.id),
      ...(context.skipReason ? { skipReason: context.skipReason } : {}),
    },
  });
}

/**
 * Whether a single evidence row can be empty or purely process-level.
 * A manual note is thin only when every clause of its summary carries
 * status/pending language (or it is empty) — a note that mixes a status
 * clause with a qualitative clause (a diagnosis, lesson, or decision) is
 * substantive. Only the summary is scanned: metadata values are arbitrary
 * (provenance, identifiers like `{"source": "agent"}`) and are not note
 * content, so they must not keep a process-only note substantive. A session
 * row is thin only when it is an auto-generated trace diagnostic
 * (`metadata.traceDiagnostic === true`).
 */
function isThinEvidence(item: EvidenceRef): boolean {
  if (item.kind === 'manual_note') return isThinManualNote(item.summary ?? '');
  if (item.kind === 'session') return item.metadata?.traceDiagnostic === true;
  return false;
}

/**
 * Clause separator for manual notes. Sentence-level punctuation starts a new
 * clause. A period only separates when sentence-final (followed by
 * whitespace or end of text), so version numbers and decimals ("v2.4.1",
 * "3.5%") stay inside their clause.
 */
const MANUAL_NOTE_CLAUSE_RE = /(?:[;!?\n]|\.(?=\s|$))+/;

/**
 * Splits a status-prefix form at its colon — but only when the suffix
 * carries diagnostic or retrospective content: a linking verb AND at least
 * four words ("root cause was lock contention"). A bare identifier, task
 * shorthand ("Pending: CI", "TODO: update docs"), or an ordinary status
 * description ("Pending: CI is running") is the label's status detail, not
 * a second substantive clause.
 */
function splitStatusPrefixClause(clause: string): string[] {
  const colonIndex = clause.indexOf(':');
  if (colonIndex < 0) return [clause];
  const label = clause.slice(0, colonIndex);
  if (!STATUS_LANGUAGE_RE.test(label)) return [clause];
  const suffix = clause.slice(colonIndex + 1);
  const suffixWords = suffix.trim().split(/\s+/).filter(Boolean).length;
  const hasLinkingVerb = /\b(?:is|are|was|were|seems?|remains?)\b/i.test(suffix);
  if (!hasLinkingVerb || suffixWords < 4) {
    return [clause];
  }
  return [label, suffix];
}

/**
 * A conjunction introducing a new subject with a linking verb, modal, or
 * status adjective — the same independent-clause shape the outcome
 * qualifier logic recognizes, used here to split manual-note clauses joined
 * only by a conjunction ("Rollout is blocked but root cause was lock
 * contention"). The subject words exclude auxiliaries so an elliptical
 * predicate ("will run and pass") is not mistaken for a new clause.
 */
const NEW_CLAUSE_SPLIT_RE =
  /\b(?:and|but|while|whereas|although|though)\s+(?:the\s+|a\s+|an\s+)?(?:(?!is\s|are\s|was\s|were\s|will\s|would\s|should\s|could\s|might\s|must\s|can\s|may\s|has\s|have\s|had\s)\w+\s+){1,3}(?:still\s+|yet\s+)?(?:is|are|was|were|has|have|had|remains?|stays?|seems?|will|would|should|could|might|must|can|may|pending|blocked|queued|incomplete|unfinished|planned|scheduled|waiting|stalled)\b/gi;

/**
 * Splits a clause at each conjunction that introduces an independent clause
 * with its own subject, mirroring the suffix qualifier boundaries.
 */
function splitAtClauseConjunctions(clause: string): string[] {
  const cuts: number[] = [];
  for (const match of clause.matchAll(NEW_CLAUSE_SPLIT_RE)) {
    cuts.push(match.index);
  }
  if (cuts.length === 0) return [clause];
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(clause.slice(start, cut));
    start = cut;
  }
  parts.push(clause.slice(start));
  return parts;
}

/**
 * Causal conjunctions. Content after them explains WHY — a diagnosis or
 * rationale ("Rollout is blocked because the cache key ignores tenant IDs")
 * — so it forms its own clause for the thinness test even when the marker
 * before it is a hard status word. "since" only counts when causal: a
 * temporal "since" starting a duration phrase ("Pending since Friday")
 * is part of the status, not a rationale.
 */
const CAUSAL_CONJUNCTION_RE =
  /\b(?:because|due\s+to|so that|since\s+(?!(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|today|tomorrow|january|february|march|april|june|july|august|september|october|november|december|morning|noon|night|evening|last|this|next|ago)\b))\b/gi;

/**
 * Splits a clause before each causal conjunction, keeping the conjunction
 * with the rationale clause that follows it.
 */
function splitAtCausalConjunctions(clause: string): string[] {
  const cuts: number[] = [];
  for (const match of clause.matchAll(CAUSAL_CONJUNCTION_RE)) {
    cuts.push(match.index);
  }
  if (cuts.length === 0) return [clause];
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(clause.slice(start, cut));
    start = cut;
  }
  parts.push(clause.slice(start));
  return parts;
}

/**
 * Whether a manual note is purely process status. Every clause of the
 * summary must be status for the note to be thin — one status token does not
 * discard a substantive clause in the same note ("Root cause was lock
 * contention; rollout is blocked pending a cache fix" keeps its
 * retrospective for the diagnosis).
 */
function isThinManualNote(summary: string): boolean {
  const clauses = summary
    .split(MANUAL_NOTE_CLAUSE_RE)
    .flatMap(splitStatusPrefixClause)
    .flatMap(splitAtClauseConjunctions)
    .flatMap(splitAtCausalConjunctions)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.every(isStatusClause);
}

/**
 * Affirmative outcome signals for the self_nag no-op gate. Unlike the preflight
 * scorer's outcome count — which matches bare keywords like "ci", "build", or
 * "test" regardless of negation or pending state — these require an outcome
 * that actually happened: a concrete PR reference, a merge/pass/fail style
 * result verb, or a quantitative result (a measured value changing to another
 * measured value, e.g. "latency dropped from 800 ms to 200 ms"). Bare
 * completion words ("done", "completed", "approved") are deliberately excluded:
 * they describe process status, not work artifacts.
 */
const AFFIRMATIVE_OUTCOME_RE =
  /\b(?:pr\s*#?\d+|pull\s+request|github\.com\/[^\s]+\/pull\/\d+|merged?|landed|shipped|pass(?:ed|ing)?|green|succeed(?:ed|ing)?|success|failed|failures?|errors?|exceptions?|crashed|fixed|closed)\b/gi;

/**
 * Structural artifact references: commit SHAs, release/semantic versions,
 * http(s) URLs, and issue references. Unlike outcome keywords — whose meaning
 * depends on surrounding negation or tense — a SHA or version token is an
 * unambiguous pointer at a concrete work artifact, so free-form results like
 * "Deployed release v2.4.1 from commit a1b2c3d" stay substantive without
 * whitelisting their wording.
 */
const ARTIFACT_REFERENCE_RE =
  /\b(?:[0-9a-f]{7,40}|v\d+(?:\.\d+)+(?:[-.][\w.]+)?|https?:\/\/[^\s]+|(?:issue|fixes|closes|resolves)\s*#?\d+)\b/gi;

/**
 * Deploy/release verbs that make a following artifact reference clearly an
 * outcome someone produced, filtering bare mentions. Kept small and past-tense.
 */
const ARTIFACT_CONTEXT_RE =
  /\b(?:deployed?|released?|published?|tagged?|built|commit(?:ted)?|bumped?|rolled? out|cut)\b[^.!?]{0,48}$/i;

/**
 * Quantitative outcome signal: a measured value changing to another measured
 * value ("800 ms to 200 ms", "3% to 5%", "1.2 GB → 900 MB"). A bare
 * measurement without a change ("800 ms") does not count — it is an
 * observation, not an outcome.
 */
const QUANTITATIVE_OUTCOME_RE =
  /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds?|min|minutes?|hours?|h|b|kb|mb|gb|tb|%|x|fps|rps|qps|req\/s|us|µs|ns)(?![a-z0-9])[^.;:!?]{0,24}\b(?:to|→|-|–)\s*\d+(?:\.\d+)?(?:\s*(?:ms|s|sec|seconds?|min|minutes?|hours?|h|b|kb|mb|gb|tb|%|x|fps|rps|qps|req\/s|us|µs|ns)(?![a-z0-9]))?/gi;

function hasQuantitativeOutcome(text: string): boolean {
  // Every measured change is examined with the same prefix AND suffix
  // qualifier checks as keyword outcomes — an earlier negated one ("no change
  // from 800 ms to 800 ms") must not hide a genuine later result, and a
  // prospective target ("800 ms to 200 ms is planned") must not count.
  for (const match of text.matchAll(QUANTITATIVE_OUTCOME_RE)) {
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    if (prefixHasQualifier(prefix)) continue;
    const end = match.index + match[0].length;
    if (suffixHasQualifier(text.slice(end, end + 48))) continue;
    return true;
  }
  return false;
}

/**
 * Prefixes that make an outcome keyword a negated, still-pending, or merely
 * prospective mention rather than an affirmative one — "CI has not run yet",
 * "waiting for tests to pass", "build still pending", "no meaningful
 * failures", "tests will pass after the patch", "Target release v2.4.1",
 * "If tests pass, rollout is scheduled tomorrow" (a conditional is not an
 * outcome). The prefix must sit within
 * the same clause: commas, semicolons, colons, line breaks, and coordinating
 * conjunctions that introduce a new clause all end it, so "No errors; tests
 * passed" and "No errors and tests passed" both count "passed" as affirmative.
 */
const NON_AFFIRMATIVE_PREFIX_RE =
  /\b(?:not|never|no|hasn'?t|haven'?t|hadn'?t|didn'?t|doesn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|cannot|without|yet|still|pending|wait(?:ing)?|queued|incomplete|unfinished|planned|scheduled|upcoming|goal|target(?:ed)?|aim|will|would|should|could|might|need(?:s|ed)? to|must|has to|have to|required to|expect(?:ed|s)? to|hop(?:e|es|ing) to|plan(?:s|ned)? to|if|when|once|unless|until)\b[^.!?;:,\n]{0,32}$/i;

/**
 * Coordinating conjunctions that can introduce a new clause. A qualifier on
 * the far side of one ("No errors AND tests passed") describes that earlier
 * clause, not the outcome being tested.
 */
const CONJUNCTION_RE = /\b(?:and|but|while|whereas|although|though)\b/gi;

/**
 * Verbs that commonly appear in coordinated predicates ("will run and report
 * failures"). When one directly follows a conjunction, the predicate shares
 * the earlier qualifier rather than starting a new clause. Ambiguous
 * noun/verb words ("tests", "pass") are excluded — they are read as the new
 * clause's subject, so the conjunction stays a boundary.
 */
const COORDINATED_VERBS = new Set([
  'run',
  'runs',
  'report',
  'reports',
  'fail',
  'fails',
  'merge',
  'merges',
  'ship',
  'ships',
  'build',
  'builds',
  'land',
  'lands',
  'close',
  'closes',
  'fix',
  'fixes',
  'deploy',
  'deploys',
  'release',
  'releases',
  'publish',
  'publishes',
  'validate',
  'validates',
  'verify',
  'verifies',
  'review',
  'reviews',
]);

/**
 * Temporal/manner adverbs that can sit between a coordinating conjunction
 * and the verb it shares ("Tests will run and eventually pass"). They
 * continue the coordinated predicate rather than starting a new clause.
 * Negation and hedge words ("not", "never", "maybe") are deliberately absent
 * — those change meaning and must fall through to the qualifier test.
 */
const INTERVENING_ADVERBS = new Set([
  'eventually',
  'finally',
  'then',
  'also',
  'always',
  'reliably',
  'consistently',
  'regularly',
  'repeatedly',
  'steadily',
  'quickly',
  'cleanly',
  'correctly',
  'properly',
  'successfully',
  'safely',
  'surely',
  'definitely',
  'certainly',
  'clearly',
]);

/**
 * Adversative conjunctions. Unlike plain "and", they introduce a contrasting
 * assertion ("Tests might pass but failed"), so an outcome directly after
 * one — even behind adverbs — starts its own clause and must not inherit the
 * earlier qualifier.
 */
const ADVERSATIVE_CONJUNCTIONS = new Set(['but', 'while', 'whereas', 'although', 'though']);

/**
 * Whether a prefix (the text before an outcome match) carries a qualifier
 * that belongs to THIS outcome's clause. A conjunction is a clause boundary
 * when it introduces a new subject ("No errors and tests passed" — "no"
 * scopes only the errors clause) or is adversative with the outcome as its
 * predicate ("Tests might pass but failed"), but NOT when it coordinates
 * predicates under a shared modal ("Tests will run and pass", "CI will run
 * and report failures", "Tests will run and eventually pass" — "will" still
 * applies).
 */
function prefixHasQualifier(prefix: string): boolean {
  let cut = -1;
  let conjunctionLength = 0;
  for (const match of prefix.matchAll(CONJUNCTION_RE)) {
    cut = match.index;
    conjunctionLength = match[0].length;
  }
  if (cut < 0) {
    return NON_AFFIRMATIVE_PREFIX_RE.test(prefix);
  }
  const conjunction = prefix.slice(cut, cut + conjunctionLength).toLowerCase();
  const words = prefix
    .slice(cut + conjunctionLength)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let index = 0;
  while (index < words.length && INTERVENING_ADVERBS.has(words[index].toLowerCase())) {
    index++;
  }
  if (index < words.length) {
    // A word that is neither an adverb nor a coordinated verb is a new
    // clause's subject; a coordinated verb ("will run and report failures")
    // shares the earlier modal.
    if (!COORDINATED_VERBS.has(words[index].toLowerCase())) {
      return NON_AFFIRMATIVE_PREFIX_RE.test(prefix.slice(cut));
    }
    return NON_AFFIRMATIVE_PREFIX_RE.test(prefix);
  }
  // Only adverbs (or nothing) sit between the conjunction and the outcome,
  // so the outcome verb itself continues the coordinated predicate ("will
  // run and eventually pass") — except after an adversative conjunction,
  // whose contrasting outcome must not inherit the earlier qualifier.
  if (ADVERSATIVE_CONJUNCTIONS.has(conjunction)) {
    return NON_AFFIRMATIVE_PREFIX_RE.test(prefix.slice(cut));
  }
  return NON_AFFIRMATIVE_PREFIX_RE.test(prefix);
}

/**
 * Suffix qualifier words that make a matched outcome reference still pending,
 * negated, or prospective — "PR #123 is still pending", "800 ms to 200 ms is
 * planned". A qualifier applies only when it continues the SAME clause as the
 * match: directly within it, or immediately after a comma. A qualifier in a
 * new independent clause — punctuated ("Tests passed; deployment pending") or
 * introduced by a conjunction with its own subject ("Tests passed and
 * deployment is still pending") — describes a different outcome's status and
 * does not apply.
 */
const SUFFIX_QUALIFIER_RE =
  /^(?:[^,;:!?.\n]{0,32}\b(?:not|never|no|hasn'?t|haven'?t|hadn'?t|didn'?t|doesn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|cannot|without|yet|still|pending|wait(?:ing)?|queued|incomplete|unfinished|tomorrow|scheduled|planned|will|would|should|could|might|goal|target(?:ed)?|aim)\b|,\s*(?:still|yet|pending|wait(?:ing)?|incomplete|unfinished|planned|scheduled|queued|without)\b)/i;

/**
 * A coordinating conjunction followed by its own (possibly multiword) subject
 * + linking verb or modal auxiliary ("and deployment is", "and the build
 * pipeline is", "but the build was", "and deployment will start") — the
 * start of a new independent clause whose qualifiers must not attach to a
 * preceding outcome match. Requires at least one subject word: an
 * omitted-subject coordinated predicate ("opened and is still pending") is
 * not a new clause.
 */
const NEW_CLAUSE_CONJUNCTION_RE =
  /\b(?:and|but|while|whereas|although|though)\s+(?:the\s+|a\s+|an\s+)?(?:\w+\s+){1,3}(?:is|are|was|were|has|have|had|remains?|stays?|seems?|will|would|should|could|might|must|can|may)\b/i;

/**
 * The same new-clause pattern in status shorthand, where the linking verb is
 * omitted ("Tests passed but deployment pending" = "but deployment [is]
 * pending"). Requires at least one non-auxiliary subject word so an
 * elliptical qualifier that directly follows the conjunction ("passing but
 * blocked", "opened and is still pending") still attaches to the outcome's
 * clause.
 */
const NEW_CLAUSE_STATUS_RE =
  /\b(?:and|but|while|whereas|although|though)\s+(?:the\s+|a\s+|an\s+)?(?:(?!is\s|are\s|was\s|were\s|will\s|would\s|should\s|could\s|might\s|must\s|can\s|may\s|has\s|have\s|had\s)\w+\s+){1,3}(?:still\s+|yet\s+)?(?:pending|blocked|queued|incomplete|unfinished|planned|scheduled|waiting|stalled)\b/i;

/**
 * Whether a suffix (the text after an outcome match) carries a qualifier that
 * belongs to THIS outcome rather than a new independent clause.
 */
function suffixHasQualifier(suffix: string): boolean {
  const match = SUFFIX_QUALIFIER_RE.exec(suffix);
  if (!match) return false;
  const segment = suffix.slice(0, match.index + match[0].length);
  // The qualifier sits in a new clause with its own subject — not ours.
  if (NEW_CLAUSE_CONJUNCTION_RE.test(segment)) return false;
  if (NEW_CLAUSE_STATUS_RE.test(segment)) return false;
  return true;
}

/**
 * Whether the selection carries an affirmative outcome signal (see
 * {@link AFFIRMATIVE_OUTCOME_RE}). A row's summary and its string-valued
 * metadata fields are scanned — serializing whole metadata objects would
 * leak key names and structure (`{"passed": false}` must not count as
 * "passed") — except for manual notes, whose metadata is provenance and
 * identifiers: an `externalUrl` can point at a still-pending PR, so only the
 * summary carries outcome content there. The gate uses this instead of the
 * preflight's `counts.outcomes`, which over-counts bare outcome keywords in
 * negated or pending phrases.
 */
function hasAffirmativeOutcome(evidence: EvidenceRef[]): boolean {
  return evidence.some((item) => {
    const texts: string[] = [];
    if (item.kind !== 'manual_note') {
      for (const value of Object.values(item.metadata ?? {})) {
        if (typeof value === 'string' && value.trim()) texts.push(value);
      }
    }
    texts.push(item.summary ?? '');
    return texts.some(hasAffirmativeOutcomeText);
  });
}

function hasAffirmativeOutcomeText(text: string): boolean {
  if (hasQuantitativeOutcome(text)) return true;
  // A deploy/release verb followed by a concrete artifact reference (SHA,
  // version, URL, issue) is an unambiguous free-form outcome.
  if (hasArtifactOutcome(text)) return true;
  for (const match of text.matchAll(AFFIRMATIVE_OUTCOME_RE)) {
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    if (prefixHasQualifier(prefix)) continue;
    const suffix = text.slice(match.index + match[0].length, match.index + match[0].length + 48);
    if (suffixHasQualifier(suffix)) continue;
    return true;
  }
  return false;
}

function hasArtifactOutcome(text: string): boolean {
  // Same prefix and suffix qualifier checks as keyword and quantitative
  // outcomes — a prospective artifact ("Release v2.4.1 is planned",
  // "Built v2.4.1 is still pending") must not count as completed work.
  for (const match of text.matchAll(ARTIFACT_REFERENCE_RE)) {
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    if (prefixHasQualifier(prefix)) continue;
    if (!ARTIFACT_CONTEXT_RE.test(prefix)) continue;
    const end = match.index + match[0].length;
    if (suffixHasQualifier(text.slice(end, end + 48))) continue;
    return true;
  }
  return false;
}

/**
 * Hard status/pending markers: the recognizable signature of process-level
 * clauses ("waiting for X", "not done yet", "no update"). The bare
 * completion words ("done", "completed", "approved") count only at the end
 * of a clause ("Done", "Migration completed") — the same word opening a
 * description of what was completed ("Completed migration to tenant-scoped
 * cache") is substantive work, not status. Bare negators are restricted to
 * status phrases: "no update", "no new signal", "never got to it", "not
 * working", and negated outcome verbs ("tests have not passed") — a
 * negative finding ("No index covers the query", "The cache is not the
 * bottleneck") is a substantive diagnosis, not process status. A clause
 * with any of these markers is process status regardless of anything else.
 */
const PENDING_MARKER_RE =
  /\b(?:waiting|wait|await(?:ing|s)?|pending|queued|incomplete|unfinished|planned|scheduled|upcoming|todo|blocked|stalled|goal|target|aim|need(?:s|ed)? to|must|has to|have to|required to|not\s+(?:yet|done|started|run|runned|finished|working|expected|passed|passing|merged|merging|landed|landing|shipped|shipping|failed|failing|green|succeed(?:ed|ing)?|deployed|released|built|closed|fixed)|no\s+(?:update|updates|movement|progress|news|change|changes|blockers?|findings?|errors?|failures?|issues?|new\s+signal|signal|new\s+work)|never\s+(?:got|started|finished|ran|completed|happened|landed|shipped|merged)|hasn'?t|haven'?t|hadn'?t|didn'?t|doesn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|cannot|later|soon|tomorrow|tbd|n\/a|(?:done|completed|approved)(?:\s+(?:this\s+tick|for\s+now|today|this\s+week|so\s+far))?\s*[.!]?$)\b/i;

/**
 * Bare modals, ambiguous between prospective work status ("tests should
 * pass", "will do Y") and a substantive recommendation or decision. When a
 * clause's only status signal is a modal, the recommendation test decides.
 */
const MODAL_MARKER_RE = /\b(?:will|would|should|could|might|maybe)\b/i;

/**
 * Recommendation/decision shapes: a first-person subject with a modal
 * ("we should …"), a modal followed by an advisory verb about the code
 * ("should avoid global mutable caches"), or a rationale clause ("because
 * teardown races"). These are substantive lessons, not prospective status,
 * so the modal alone must not make the clause thin. "must" and the
 * ship/deploy verbs are deliberately absent — "must publish release v3.0.0"
 * is required work, and hard pending markers already outrank this test.
 */
const RECOMMENDATION_RE =
  /\b(?:we|i|one)\s+(?:should|could|would|might)\b|\b(?:should|could|would|might)\s+(?:avoid|use|prefer|adopt|remove|replace|refactor|extract|split|gate|wrap|isolate|pin|disable|enable|standardize|document|migrate|upgrade|introduce|drop|add|move|cache)\b|\b(?:because|so that|to avoid|to prevent|since|otherwise)\b/i;

/**
 * Whether a manual-note clause is process status. Hard pending markers
 * decide immediately; a bare modal leaves the clause thin only when it does
 * not read as a recommendation.
 */
function isStatusClause(clause: string): boolean {
  if (PENDING_MARKER_RE.test(clause)) return true;
  if (!MODAL_MARKER_RE.test(clause)) return false;
  return !RECOMMENDATION_RE.test(clause);
}

/**
 * Status/pending language for status-prefix labels: the full vocabulary
 * (hard markers plus the bare modals) — a "Will:" label splits its colon
 * even though a modal mid-clause needs the recommendation test.
 */
const STATUS_LANGUAGE_RE =
  /\b(?:waiting|wait|await(?:ing|s)?|pending|queued|incomplete|unfinished|planned|scheduled|upcoming|todo|done|completed|approved|blocked|stalled|goal|target|aim|need(?:s|ed)? to|must|has to|have to|required to|not\s+(?:yet|done|started|run|runned)|hasn'?t|haven'?t|hadn'?t|didn'?t|doesn'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|cannot|no\s|never|not\s|will|would|should|could|might|maybe|later|soon|tomorrow|tbd|n\/a)\b/i;

/**
 * A self_nag tick is a no-op worth skipping when the selection itself carries
 * no substantive signal: no affirmative outcome (a PR reference or a
 * merge/pass/fail/quantitative/artifact result — not a negated, pending, or
 * prospective mention) and every row thin. A manual note is thin only when
 * every clause of it carries status/pending language (or it is empty) — a
 * note mixing a status clause with substantive qualitative content still
 * keeps its episode. The
 * preflight level is advisory only — scope-wide metrics and loose keyword
 * outcomes can inflate a thin batch to medium, so the selection-aware content
 * test decides rather than the score. Any structural/task-linked evidence
 * kind (task results, friction traces, artifacts, errors, in-batch metrics,
 * genuine session summaries) keeps its retrospective.
 */
function shouldSkipSelfNagNoOp(evidence: EvidenceRef[]): boolean {
  if (hasAffirmativeOutcome(evidence)) return false;
  return evidence.length > 0 && evidence.every(isThinEvidence);
}

function recordSelfNagNoOpNote(
  deps: GoalAutomationExecuteDeps,
  goal: SpaceGoal,
  preflight: EvidenceQualityPreflight
): void {
  if (!deps.goalEventRepo) return;
  deps.goalEventRepo.create({
    spaceId: goal.spaceId,
    goalId: goal.id,
    eventType: 'automation_noop',
    source: 'scheduler',
    sourceTaskId: null,
    sourceSessionId: null,
    previousState: null,
    newState: null,
    diff: null,
    note: `Self-nag retrospective skipped: evidence-quality preflight is ${preflight.level} (score ${preflight.score}/${preflight.maxScore}) and the selection carries no affirmative outcome signal — every evidence row is a manual note or an empty session trace diagnostic. No episode or review task generated.`,
  });
}

function emitTaskCreated(deps: GoalAutomationExecuteDeps, task: SpaceTask): void {
  deps.taskCreatedEventHub
    ?.publish('space.task.created', {
      sessionId: 'global',
      spaceId: task.spaceId,
      taskId: task.id,
      task,
    })
    .catch((err) => log.warn('failed to publish automation review task', err));
}

function validatePayload(payload: Record<string, unknown>): GoalAutomationExecutePayload {
  const goalId = requiredString(payload.goalId, 'goalId');
  const scopeId = requiredString(payload.scopeId, 'scopeId');
  const triggerKind = enumValue(payload.triggerKind, [
    'completed_task_threshold',
    'self_nag',
    'external_event',
  ] as const);
  const triggerKey = requiredString(payload.triggerKey, 'triggerKey');
  const reason = enumValue(payload.reason, [
    'task_completed',
    'self_nag',
    'external_event',
  ] as const);
  return {
    goalId,
    scopeId,
    triggerKind,
    triggerKey,
    reason,
    taskId: optionalString(payload.taskId),
    scheduleId: optionalString(payload.scheduleId),
    externalEventId: optionalString(payload.externalEventId),
    externalEvent: normalizeExternalEvent(payload.externalEvent),
    activeReviewRequeueCount: optionalPositiveInteger(payload.activeReviewRequeueCount),
  };
}

function normalizeExternalEvent(value: unknown): GoalAutomationExternalEventSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    source: requiredString(record.source, 'externalEvent.source'),
    topic: requiredString(record.topic, 'externalEvent.topic'),
    summary: requiredString(record.summary, 'externalEvent.summary'),
    externalUrl: optionalString(record.externalUrl),
    payload:
      record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : {},
    occurredAt: typeof record.occurredAt === 'number' ? record.occurredAt : Date.now(),
    ingestedAt: typeof record.ingestedAt === 'number' ? record.ingestedAt : Date.now(),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readMaxEvidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 12;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function requeueActiveReview(
  deps: GoalAutomationExecuteDeps,
  payload: GoalAutomationExecutePayload,
  evidenceCount: number
): GoalAutomationExecuteResult {
  const requeueCount = readActiveReviewRequeueCount(payload);
  const requeuePayload = {
    ...payload,
    activeReviewRequeueCount: requeueCount + 1,
  };
  const delay = requeueCount >= MAX_ACTIVE_REVIEW_REQUEUES ? EXTENDED_REQUEUE_DELAY_MS : 60_000;
  deps.jobQueue?.enqueueUniquePending({
    queue: GOAL_AUTOMATION_EXECUTE,
    payload: requeuePayload,
    matchPayload: uniqueJobMatchPayload(payload),
    activeStatuses: ['pending'],
    maxRetries: 2,
    runAt: Date.now() + delay,
  });
  return {
    ...skipped(payload, 'active_review', evidenceCount),
    requeued: !!deps.jobQueue,
  };
}

function readActiveReviewRequeueCount(payload: GoalAutomationExecutePayload): number {
  const value = payload.activeReviewRequeueCount;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function uniqueJobMatchPayload(payload: GoalAutomationExecutePayload): Record<string, unknown> {
  const matchPayload: Record<string, unknown> = {
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    triggerKind: payload.triggerKind,
    triggerKey: payload.triggerKey,
  };
  if (payload.externalEventId !== undefined) {
    matchPayload.externalEventId = payload.externalEventId;
  }
  return matchPayload;
}

function skipped(
  payload: GoalAutomationExecutePayload,
  skipReason: NonNullable<GoalAutomationExecuteResult['skipReason']>,
  evidenceCount = 0
): GoalAutomationExecuteResult {
  return {
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    episodeId: null,
    reviewTaskId: null,
    evidenceCount,
    skipped: true,
    skipReason,
  };
}
