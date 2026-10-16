import type {
  EvolutionScope,
  SpaceGoal,
  EvolutionEpisode,
  EvolutionLesson,
  TaskProposal,
  EvidenceRef,
  EvolutionEvidenceListResponse,
  MetricSnapshot,
  EvolutionMetricSnapshotListResponse,
  EvolutionEpisodeReviewBundleResponse,
  EvolutionEpisodeCreateResponse,
  EvolutionTaskProposalCreateTaskResponse,
  EvolutionRollupApplyResponse,
  EvolutionFinding,
  EvolutionFindingDomain,
} from '@hyperneo/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks';
import type { ProposalEditDraft, RollupDraft, ReviewAction } from './space-forge-values.ts';
import {
  EVIDENCE_PAGE_SIZE,
  mergePreflightContext,
  buildEvidenceQualityPreflight,
  EPISODE_JUDGE_TIMEOUT_MS,
  createProposalDraft,
  nextStepsFromText,
  formatKind,
} from './space-forge-values.ts';
import { toast } from '../../lib/toast';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { FORM_CONTROL_CLASS } from '../ui/FormField';
import type { ComponentChild } from 'preact';

export function EpisodesTab({ scope, goal }: { scope: EvolutionScope; goal: SpaceGoal | null }) {
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
                  class={cn(FORM_CONTROL_CLASS, 'resize-none')}
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
                class={cn(FORM_CONTROL_CLASS, 'mt-3 resize-none')}
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
                          class={FORM_CONTROL_CLASS}
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
                          class={cn(FORM_CONTROL_CLASS, 'resize-none')}
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
                          class={cn(FORM_CONTROL_CLASS, 'resize-none')}
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
                          class={FORM_CONTROL_CLASS}
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
