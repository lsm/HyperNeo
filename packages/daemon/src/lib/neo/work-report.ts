import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { DaemonInventoryLink } from '@hyperneo/shared/types/daemon-snapshot';
import type { OperationCaller } from '../operations/registry.ts';
import { canonicalNeoWorkResourceRefs, selectNeoWorkResourceRefs } from './work-resource-refs.ts';

export interface NeoWorkReportInput {
  id: string;
  status: 'reported' | 'failed';
  report: string;
  resourceRefs?: DaemonInventoryLink[];
}
type Rejection = {
  accepted: false;
  reason:
    | 'invalid_report'
    | 'recipient_required'
    | 'work_not_found'
    | 'recipient_mismatch'
    | 'invalid_recipient_binding'
    | 'recipient_is_coordinator'
    | 'work_not_pending'
    | 'report_conflict'
    | 'superseded';
};
type Gate<T> = { value: T } | { reason: Rejection };
type Plan = { replayed: boolean };
type SettledWork = NeoWork & Pick<NeoWorkReportInput, 'status'>;
type Receipt = {
  accepted: true;
  workId: string;
  status: NeoWorkReportInput['status'];
  replayed: boolean;
};
export interface NeoWorkReportDependencies {
  readWork(id: string): NeoWork | null;
  readBinding(sessionId: string): NeoBinding | null;
  transitionWork(
    id: string,
    expected: Pick<NeoWork, 'status' | 'sessionId' | 'report'>,
    patch: Pick<NeoWork, 'status' | 'report'>
  ): NeoWork | null;
  returnReport(work: NeoWork): Promise<void>;
  resourceReports?: {
    get(workId: string): DaemonInventoryLink[] | null;
    settle(
      expected: NeoWork,
      input: NeoWorkReportInput,
      resourceRefs: DaemonInventoryLink[]
    ): NeoWork | null;
  };
}
const reject = (reason: Rejection['reason']): { reason: Rejection } => ({
  reason: { accepted: false, reason },
});

export function admitNeoWorkReportInput(input: NeoWorkReportInput): Gate<NeoWorkReportInput> {
  if (
    !input.id.trim() ||
    !input.report.trim() ||
    input.report.length > 12000 ||
    !['reported', 'failed'].includes(input.status)
  )
    return reject('invalid_report');
  const value = { id: input.id, status: input.status, report: input.report };
  if (input.resourceRefs === undefined) return { value };
  const refs = selectNeoWorkResourceRefs(input.resourceRefs);
  return 'reason' in refs
    ? reject('invalid_report')
    : { value: { ...value, resourceRefs: canonicalNeoWorkResourceRefs(refs.value) } };
}

export function admitNeoWorkReportCaller(caller: OperationCaller): Gate<{ sessionId: string }> {
  return caller.source === 'mcp' && caller.sessionId?.trim()
    ? { value: { sessionId: caller.sessionId } }
    : reject('recipient_required');
}

export function requireNeoWorkReportRecord(
  input: NeoWorkReportInput,
  record: { work: NeoWork | null }
): Gate<NeoWork> {
  return record.work?.id === input.id ? { value: record.work } : reject('work_not_found');
}

export function requireNeoWorkReportOwner(
  work: NeoWork,
  recipient: { sessionId: string }
): Gate<NeoWork> {
  return work.sessionId === recipient.sessionId ? { value: work } : reject('recipient_mismatch');
}

export function requireNeoWorkReportBinding(
  work: NeoWork,
  record: { binding: NeoBinding | null }
): Gate<NeoWork> {
  if (record.binding && record.binding.sessionId !== work.sessionId)
    return reject('invalid_recipient_binding');
  return !record.binding || record.binding.kind === 'worker'
    ? { value: work }
    : reject('recipient_is_coordinator');
}

export function planNeoWorkReport(work: NeoWork, input: NeoWorkReportInput): Gate<Plan> {
  if (work.status === 'queued') return { value: { replayed: false } };
  if (work.status === 'reported' || work.status === 'failed')
    return work.status === input.status && work.report === input.report
      ? { value: { replayed: true } }
      : reject('report_conflict');
  return reject('work_not_pending');
}

export function requireNeoWorkReportResources(
  input: NeoWorkReportInput,
  plan: Plan,
  record: { supported: boolean; refs: DaemonInventoryLink[] | null }
): Gate<Plan> {
  if (input.resourceRefs === undefined) return { value: plan };
  if (!record.supported) return reject('invalid_report');
  return !plan.replayed || JSON.stringify(record.refs) === JSON.stringify(input.resourceRefs)
    ? { value: plan }
    : reject('report_conflict');
}

export function requireSettledNeoWorkReport(
  expected: NeoWork,
  input: NeoWorkReportInput,
  record: { work: NeoWork | null }
): Gate<SettledWork> {
  const work = record.work;
  return work &&
    work.id === expected.id &&
    work.sessionId === expected.sessionId &&
    work.originSessionId === expected.originSessionId &&
    work.originMessageId === expected.originMessageId &&
    work.status === input.status &&
    work.report === input.report
    ? { value: { ...work, status: input.status } }
    : reject('superseded');
}

export function presentNeoWorkReport(work: SettledWork, plan: Plan): Receipt {
  return {
    accepted: true,
    workId: work.id,
    status: work.status,
    replayed: plan.replayed,
  };
}

export function createNeoWorkReporter(deps: NeoWorkReportDependencies) {
  return (superpipe({})('neo-work-recipient-report') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitNeoWorkReportInput, 'input', 'result:report')
    .pipe((input: NeoWorkReportInput) => input, 'report', 'input')
    .pipe(admitNeoWorkReportCaller, 'caller', 'result:report')
    .pipe((recipient: { sessionId: string }) => recipient, 'report', 'recipient')
    .pipe((input: NeoWorkReportInput) => ({ work: deps.readWork(input.id) }), 'input', 'record')
    .pipe(requireNeoWorkReportRecord, ['input', 'record'], 'result:report')
    .pipe(requireNeoWorkReportOwner, ['report', 'recipient'], 'result:report')
    .pipe((work: NeoWork) => ({ binding: deps.readBinding(work.sessionId!) }), 'report', 'binding')
    .pipe(requireNeoWorkReportBinding, ['report', 'binding'], 'result:report')
    .pipe((work: NeoWork) => work, 'report', 'work')
    .pipe(planNeoWorkReport, ['work', 'input'], 'result:report')
    .pipe((plan: Plan) => plan, 'report', 'plan')
    .pipe(
      (work: NeoWork, input: NeoWorkReportInput, plan: Plan) => ({
        supported: !!deps.resourceReports,
        refs:
          plan.replayed && input.resourceRefs !== undefined
            ? (deps.resourceReports?.get(work.id) ?? null)
            : null,
      }),
      ['work', 'input', 'plan'],
      'resources'
    )
    .pipe(requireNeoWorkReportResources, ['input', 'plan', 'resources'], 'result:report')
    .pipe(
      (work: NeoWork, input: NeoWorkReportInput, plan: Plan) => ({
        work: plan.replayed
          ? work
          : input.resourceRefs !== undefined
            ? (deps.resourceReports?.settle(work, input, input.resourceRefs) ?? null)
            : deps.transitionWork(work.id, work, { status: input.status, report: input.report }),
      }),
      ['work', 'input', 'plan'],
      'settled'
    )
    .pipe(requireSettledNeoWorkReport, ['work', 'input', 'settled'], 'result:report')
    .pipe(
      async (work: SettledWork) => {
        await deps.returnReport(work);
        return work;
      },
      'report',
      'report'
    )
    .pipe(presentNeoWorkReport, ['report', 'plan'], 'report')
    .endAsync('report') as (
    input: NeoWorkReportInput,
    caller: OperationCaller
  ) => Promise<Receipt | Rejection>;
}
