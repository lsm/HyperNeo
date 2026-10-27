import type { CodingMergeLocalAdmission } from './merge-local-state.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  CodingMergeGate,
  sameCodingWorkRef,
  type CodingDeliveryFactsRepository,
} from './delivery-facts.ts';
import { codingStagePasses, type CodingStageFact } from './stage-facts.ts';
type Candidate = {
  url: string;
  head: string;
  open: boolean;
  requiredCiGreen: boolean;
  findingsResolved: boolean;
  humanSignoffSatisfied: boolean;
  ciEvidence: string[];
  reviewEvidence: string[];
};
type Contract = {
  reference: string;
  write: WorkRef;
  qa: WorkRef;
  reviewer?: WorkRef;
  bot?: string;
};
type Rejection = { accepted: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
const refuse = (reason: string): { reason: Rejection } => ({ reason: { accepted: false, reason } });
export const prepareCodingMerge = (superpipe({})('coding.prepare-manual-merge') as PipelineAPI)
  .input(['repo', 'todoId', 'candidate', 'contract', 'review', 'facts', 'readHead', 'admission'])
  .pipe(
    (candidate: Candidate): Gate<Candidate> =>
      candidate.open &&
      candidate.head &&
      candidate.requiredCiGreen &&
      candidate.ciEvidence.length &&
      candidate.findingsResolved &&
      candidate.humanSignoffSatisfied
        ? { value: candidate }
        : refuse('merge_requirements_not_satisfied'),
    'candidate',
    'result:result'
  )
  .pipe(
    (
      candidate: Candidate,
      contract: Contract,
      review: { kind: string; head: string },
      facts: readonly CodingStageFact[]
    ): Gate<CodingMergeGate> => {
      const passes = (fact: CodingStageFact, ref: WorkRef) =>
        codingStagePasses(fact, candidate.url, candidate.head, contract.reference, ref);
      const reviewFact = facts.find(
        (fact) => fact.stage === 'review' && contract.reviewer && passes(fact, contract.reviewer)
      );
      const reviewerId =
        review.kind === 'bot' &&
        'approved' in review &&
        review.approved === true &&
        'login' in review &&
        typeof review.login === 'string' &&
        review.login.toLowerCase() === contract.bot?.toLowerCase()
          ? review.login
          : !contract.bot &&
              review.kind === 'session' &&
              'sessionId' in review &&
              typeof review.sessionId === 'string' &&
              !!reviewFact &&
              contract.reviewer?.id === review.sessionId
            ? review.sessionId
            : null;
      if (
        !reviewerId ||
        (review.kind === 'bot' && !candidate.reviewEvidence.length) ||
        review.head !== candidate.head ||
        (contract.reviewer && sameCodingWorkRef(contract.reviewer, contract.write))
      )
        return refuse('matching_head_review_required');
      const qa = facts.find((fact) => fact.stage === 'qa' && passes(fact, contract.qa));
      if (
        !qa ||
        sameCodingWorkRef(contract.qa, contract.write) ||
        (contract.reviewer && sameCodingWorkRef(contract.qa, contract.reviewer))
      )
        return refuse('independent_matching_head_qa_required');
      const gate = CodingMergeGate.safeParse({
        url: candidate.url,
        head: candidate.head,
        acceptanceContract: contract.reference,
        write: contract.write,
        reviewer: review.kind === 'bot' ? reviewerId : contract.reviewer,
        qa: contract.qa,
        evidence: [
          ...candidate.ciEvidence,
          ...candidate.reviewEvidence,
          ...qa.evidence,
          ...(reviewFact?.evidence ?? []),
        ],
      });
      return gate.success ? { value: gate.data } : refuse('merge_evidence_required');
    },
    ['candidate', 'contract', 'review', 'facts'],
    'result:result'
  )
  .pipe((result: CodingMergeGate) => result, 'result', 'gate')
  .pipe(
    async (
      gate: CodingMergeGate,
      readHead: () => Promise<string | null>
    ): Promise<Gate<CodingMergeGate>> =>
      (await readHead()) === gate.head
        ? { value: gate }
        : refuse('head_changed_before_manual_merge'),
    ['gate', 'readHead'],
    'result:result'
  )
  .pipe(
    async (
      repo: CodingDeliveryFactsRepository,
      todoId: string,
      gate: CodingMergeGate,
      admission?: CodingMergeLocalAdmission
    ) => {
      if (!(await repo.recordGateCurrent(todoId, gate, admission)))
        return { accepted: false, reason: 'merge_receipt_changed' };
      return {
        accepted: true,
        head: gate.head,
        command: ['gh', 'pr', 'merge', gate.url, '--squash', '--match-head-commit', gate.head],
      };
    },
    ['repo', 'todoId', 'gate', 'admission'],
    'result'
  )
  .endAsync('result') as (
  repo: CodingDeliveryFactsRepository,
  todoId: string,
  candidate: Candidate,
  contract: Contract,
  review: { kind: string; head: string },
  facts: readonly CodingStageFact[],
  readHead: () => Promise<string | null>,
  admission?: CodingMergeLocalAdmission
) => Promise<{ accepted: true; head: string; command: string[] } | Rejection>;
