import type { CodingAssignmentsRepository } from './assignments.ts';
import { decideCodingDaemonMerge, type CodingDaemonMergeFacts } from './daemon-merge-gates.ts';
import type { CodingMergePolicy } from './pr-ledger.ts';

export function codingReviewCoversMergeHold(
  facts: CodingDaemonMergeFacts,
  policy: CodingMergePolicy,
  head: string,
  handoffs: Awaited<ReturnType<CodingAssignmentsRepository['reviewHoldsCurrent']>>
): boolean {
  return (
    facts.ok &&
    facts.head === head &&
    facts.labels?.includes('human-merge') === true &&
    decideCodingDaemonMerge(
      { ...facts, labels: facts.labels.filter((label) => label !== 'human-merge') },
      policy
    ).kind === 'merge' &&
    handoffs.length > 0 &&
    handoffs.every(
      (handoff) =>
        handoff.assignment?.state === 'pending' &&
        handoff.assignment.receipt !== undefined &&
        handoff.state === 'doing' &&
        handoff.blockedBy === null &&
        !handoff.questionOpen
    )
  );
}
