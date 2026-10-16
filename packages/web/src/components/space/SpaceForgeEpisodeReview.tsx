import type {
  EvolutionEpisode,
  EvolutionFinding,
  EvolutionFindingDomain,
  EvolutionLesson,
  TaskProposal,
} from '@hyperneo/shared';
import type { ComponentChild } from 'preact';
import type { Dispatch, StateUpdater } from 'preact/hooks';
import type { ProposalEditDraft, RollupDraft, ReviewAction } from './space-forge-values.ts';
import { formatKind } from './space-forge-values.ts';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { FORM_CONTROL_CLASS } from '../ui/FormField';

export function EpisodeReview({
  loading,
  latestEpisode,
  canApplyRollup,
  rollupDraft,
  setRollupDraft,
  applyRollup,
  submitting,
  groupedFindings,
  frictionFindings,
  candidateLessons,
  proposedTasks,
  editingProposalId,
  proposalDraft,
  setProposalDraft,
  updateReviewItem,
  createTaskFromProposal,
  beginEditProposal,
}: {
  loading: boolean;
  latestEpisode: EvolutionEpisode | null;
  canApplyRollup: boolean;
  rollupDraft: RollupDraft;
  setRollupDraft: Dispatch<StateUpdater<RollupDraft>>;
  applyRollup: () => Promise<void>;
  submitting: boolean;
  groupedFindings: Record<EvolutionFindingDomain, EvolutionFinding[]>;
  frictionFindings: EvolutionFinding[];
  candidateLessons: EvolutionLesson[];
  proposedTasks: TaskProposal[];
  editingProposalId: string | null;
  proposalDraft: ProposalEditDraft | null;
  setProposalDraft: Dispatch<StateUpdater<ProposalEditDraft | null>>;
  updateReviewItem: (action: ReviewAction) => Promise<void>;
  createTaskFromProposal: (proposal: TaskProposal, draft?: ProposalEditDraft) => Promise<void>;
  beginEditProposal: (proposal: TaskProposal) => void;
}) {
  return loading ? (
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
