import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { OperationCaller } from '../operations/registry.ts';

export interface NeoWorkReportInput {
  id: string;
  status: 'reported' | 'failed';
  report: string;
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
}
const reject = (reason: Rejection['reason']): { reason: Rejection } => ({
  reason: { accepted: false, reason },
});

export function admitNeoWorkReportInput(input: NeoWorkReportInput): Gate<NeoWorkReportInput> {
  return input.id.trim() &&
    input.report.trim() &&
    input.report.length <= 12000 &&
    ['reported', 'failed'].includes(input.status)
    ? { value: { id: input.id, status: input.status, report: input.report } }
    : reject('invalid_report');
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
        work: plan.replayed
          ? work
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
