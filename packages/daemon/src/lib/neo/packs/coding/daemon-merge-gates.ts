import { codingReviewMatches } from './review.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { CodingMergePolicy } from './pr-ledger.ts';
import { codingHumanSignoff } from './human-signoff.ts';

export type CodingDaemonMergeFacts =
  | { ok: false; reason: string }
  | {
      ok: true;
      head: string;
      closingIssuesReferences?: readonly { url: string }[];
      linkedIssueReason?: string | null;
      state: string;
      draft: boolean;
      mergeable: string;
      passingCommitStatus: boolean;
      requiredCi: { head: string; green: boolean; count: number };
      threads: { head: string; unresolved: number };
      reviews: readonly { login: string; type?: string; head: string; state: string }[];
      files: readonly string[] | null;
      labels: readonly string[] | null;
    };
type Facts = Extract<CodingDaemonMergeFacts, { ok: true }>;
type Decision =
  | { kind: 'merge'; head: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'needs_human_signoff' }
  | { kind: 'read_failure'; reason: string };
type Gate = { value: Facts } | { reason: Decision };
const skip = (reason: string): Gate => ({ reason: { kind: 'skip', reason } });
const readFacts = (facts: CodingDaemonMergeFacts): Gate =>
  !facts.ok
    ? { reason: { kind: 'read_failure', reason: facts.reason } }
    : !/^[a-f\d]{40}$/i.test(facts.head) ||
        !Number.isSafeInteger(facts.requiredCi.count) ||
        facts.requiredCi.count < 0
      ? { reason: { kind: 'read_failure', reason: 'head_unreadable' } }
      : { value: facts };
const requireDaemon = (facts: Facts, policy: CodingMergePolicy): Gate =>
  policy.mergeBy !== 'daemon'
    ? skip('merge_by_owner')
    : !policy.mergePolicy
      ? skip('merge_policy_unresolved')
      : { value: facts };
const requireOpen = (facts: Facts): Gate =>
  facts.state === 'OPEN' && !facts.draft && facts.mergeable === 'MERGEABLE'
    ? { value: facts }
    : skip('pr_not_open_mergeable');
const requireCi = (facts: Facts): Gate =>
  facts.requiredCi.head === facts.head && facts.requiredCi.green
    ? { value: facts }
    : skip('required_ci_not_green_on_head');
const requireCommitReady = (facts: Facts): Gate =>
  facts.passingCommitStatus ? { value: facts } : skip('github_merge_not_ready');
const requireReview = (facts: Facts, policy: CodingMergePolicy): Gate => {
  const latest = facts.reviews
    .filter(
      (review) =>
        codingReviewMatches(review, policy.reviewBot) &&
        !['COMMENTED', 'PENDING'].includes(review.state)
    )
    .at(-1);
  return policy.mergePolicy !== 'review_bot' ||
    (latest?.head === facts.head && latest.state === 'APPROVED')
    ? { value: facts }
    : skip('matching_head_bot_approval_required');
};
const requireResolved = (facts: Facts): Gate =>
  facts.threads.head === facts.head && facts.threads.unresolved === 0
    ? { value: facts }
    : skip('review_threads_unresolved_or_stale');
export const codingNoChecksNeedsHuman = (policy: CodingMergePolicy, count: number) =>
  count === 0 &&
  !(policy.mergePolicy === 'review_bot' && policy.reviewBot) &&
  !(policy.mergePolicy === 'ci_only' && policy.allowNoChecksMerge === true);

const requireNoSignoff = (facts: Facts, policy: CodingMergePolicy): Gate => {
  const signoff = codingHumanSignoff(policy.humanSignoff ?? [], facts.files, facts.labels);
  return policy.mergePolicy === 'human' ||
    signoff === true ||
    codingNoChecksNeedsHuman(policy, facts.requiredCi.count)
    ? { reason: { kind: 'needs_human_signoff' } }
    : signoff === null
      ? { reason: { kind: 'read_failure', reason: 'signoff_scope_incomplete' } }
      : { value: facts };
};

export const decideCodingDaemonMerge = (superpipe({})('coding.decide-daemon-merge') as PipelineAPI)
  .input(['facts', 'policy'])
  .pipe(readFacts, 'facts', 'result:decision')
  .pipe(requireDaemon, ['decision', 'policy'], 'result:decision')
  .pipe(requireOpen, 'decision', 'result:decision')
  .pipe(requireCi, 'decision', 'result:decision')
  .pipe(requireCommitReady, 'decision', 'result:decision')
  .pipe(requireReview, ['decision', 'policy'], 'result:decision')
  .pipe(requireResolved, 'decision', 'result:decision')
  .pipe(requireNoSignoff, ['decision', 'policy'], 'result:decision')
  .pipe(
    (facts: Facts): Gate =>
      facts.linkedIssueReason ? skip(facts.linkedIssueReason) : { value: facts },
    'decision',
    'result:decision'
  )
  .pipe((facts: Facts): Decision => ({ kind: 'merge', head: facts.head }), 'decision', 'decision')
  .end('decision') as (facts: CodingDaemonMergeFacts, policy: CodingMergePolicy) => Decision;

export const decideCodingHumanHandoff = (
  superpipe({})('coding.decide-human-handoff') as PipelineAPI
)
  .input(['facts', 'policy', 'head'])
  .pipe(readFacts, 'facts', 'result:decision')
  .pipe(requireOpen, 'decision', 'result:decision')
  .pipe(requireCi, 'decision', 'result:decision')
  .pipe(requireResolved, 'decision', 'result:decision')
  .pipe(
    (facts: Facts, policy: CodingMergePolicy, head: string): Gate =>
      facts.head === head && codingNoChecksNeedsHuman(policy, facts.requiredCi.count)
        ? { value: facts }
        : skip('no_human_handoff'),
    ['decision', 'policy', 'head'],
    'result:decision'
  )
  .pipe(() => true, 'decision', 'decision')
  .end('decision') as (
  facts: CodingDaemonMergeFacts,
  policy: CodingMergePolicy,
  head: string
) => true | Decision;
