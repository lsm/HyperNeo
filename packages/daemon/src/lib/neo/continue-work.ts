import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CONTINUE_LIMIT, type NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { isNeoAskLive } from './done-check.ts';
import {
  type DriverSent,
  NEO_ASK_CONTINUES_SPENT,
  readDriverOutcome,
  readNeoWorkContinueBudget,
} from './driver-work.ts';

export type NeoContinueResult = { ok: true; work: NeoWork } | { ok: false; reason: string };
type Rejection = Extract<NeoContinueResult, { ok: false }>;
type Delivered = Exclude<ReturnType<typeof readDriverOutcome>, { failure: string }>;

export interface NeoContinueEvidence {
  work: NeoWork | null;
  ref: WorkRef | null;
  continuedCount: number | null;
  inFlight: boolean;
  ask: NeoAsk | null;
}

export interface NeoContinueTarget {
  work: NeoWork;
  ref: WorkRef;
}

export interface NeoContinueDeps {
  readWork(id: string): NeoWork | null;
  readRef(id: string): WorkRef | null;
  readContinuedCount(id: string): number | null;
  readAsk(id: string): NeoAsk | null;
  isContinuing(id: string): boolean;
  withGoal(id: string, message: string): string;
  readSendBaseline(
    target: NeoContinueTarget,
    message: string
  ): Promise<{ baseline: number | null; sent: DriverSent | null }>;
  send(target: NeoContinueTarget, message: string): Promise<OperationOutcome>;
  recordSent(id: string, startedAt: number | null, sent: DriverSent | null): void;
  recordContinue(id: string, message: string, now: number): number | null;
  reserveAskContinue(ask: NeoAsk): boolean;
  refundAskContinue(ask: NeoAsk): void;
  reopen(id: string, current: NeoWork, report: string): NeoWork | null;
  reopenAsk(id: string): void;
}

const reject = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export function requireNeoWorkContinuable(
  evidence: NeoContinueEvidence,
  now: number
): { value: NeoContinueTarget } | { reason: Rejection } {
  const { work, ref } = evidence;
  if (!work || !ref) return reject('Only started driver work can be continued.');
  if (work.status !== 'queued' && work.status !== 'reported')
    return reject(`This work already ${work.status}; it cannot be continued.`);
  const budget = readNeoWorkContinueBudget(
    evidence.continuedCount === null ? null : { count: evidence.continuedCount },
    work.createdAt,
    evidence.ask,
    now
  );
  if (budget) return reject(budget);
  if (evidence.inFlight)
    return reject('This work is already being continued; wait for that first.');
  return { value: { work, ref } };
}

type NeoAskContinueReserve = { ask: NeoAsk | null; ok: boolean };

export function requireNeoAskContinueReserved(
  reserved: NeoAskContinueReserve
): { value: NeoAskContinueReserve } | { reason: Rejection } {
  return reserved.ok ? { value: reserved } : reject(NEO_ASK_CONTINUES_SPENT);
}

export function requireNeoContinueDelivered(
  target: NeoContinueTarget,
  outcome: OperationOutcome
): { value: Delivered } | { reason: Rejection } {
  const delivered = readDriverOutcome({ verb: 'send', ref: target.ref }, outcome);
  return 'failure' in delivered ? reject(delivered.failure) : { value: delivered };
}

export function requireNeoWorkStillContinuable(current: {
  work: NeoWork;
}): { value: NeoWork } | { reason: Rejection } {
  const { status } = current.work;
  return status === 'queued' || status === 'reported'
    ? { value: current.work }
    : reject(`The message was sent, but this work was ${status} meanwhile; it stays ${status}.`);
}

export function neoContinuedReport(count: number, message: string, pooled = false): string {
  return `Continued ${count}${pooled ? '' : `/${NEO_WORK_CONTINUE_LIMIT}`}: ${message.slice(0, 300)}`;
}

export const admitNeoWorkContinue = (superpipe({})('neo.work.continue.admit') as PipelineAPI)
  .input(['deps', 'id', 'now'])
  .pipe(
    (deps: NeoContinueDeps, id: string): NeoContinueEvidence => ({
      work: deps.readWork(id),
      ref: deps.readRef(id),
      continuedCount: deps.readContinuedCount(id),
      inFlight: deps.isContinuing(id),
      ask: deps.readAsk(id),
    }),
    ['deps', 'id'],
    'evidence'
  )
  .pipe(requireNeoWorkContinuable, ['evidence', 'now'], 'result:admission')
  .end('admission') as (
  deps: NeoContinueDeps,
  id: string,
  now: number
) => NeoContinueTarget | Rejection;

export const sendNeoWorkContinue = (superpipe({})('neo.work.continue.send') as PipelineAPI)
  .input(['deps', 'target', 'message', 'now'])
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget, message: string) => ({
      text: deps.withGoal(target.work.id, message),
    }),
    ['deps', 'target', 'message'],
    'sending'
  )
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget, sending: { text: string }) =>
      deps.readSendBaseline(target, sending.text),
    ['deps', 'target', 'sending'],
    'probe'
  )
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget) => {
      const ask = deps.readAsk(target.work.id);
      if (ask?.approvedAt == null || !isNeoAskLive(ask)) return { ask: null, ok: true };
      return { ask, ok: deps.reserveAskContinue(ask) };
    },
    ['deps', 'target'],
    'reserved'
  )
  .pipe(requireNeoAskContinueReserved, 'reserved', 'result:continued')
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget, sending: { text: string }) =>
      deps.send(target, sending.text),
    ['deps', 'target', 'sending'],
    'outcome'
  )
  .pipe(
    (
      deps: NeoContinueDeps,
      target: NeoContinueTarget,
      reserved: NeoAskContinueReserve,
      outcome: OperationOutcome
    ) => {
      if (reserved.ask && 'reason' in requireNeoContinueDelivered(target, outcome))
        deps.refundAskContinue(reserved.ask);
    },
    ['deps', 'target', 'reserved', 'outcome']
  )
  .pipe(requireNeoContinueDelivered, ['target', 'outcome'], 'result:continued')
  .pipe(
    (
      deps: NeoContinueDeps,
      target: NeoContinueTarget,
      probe: { baseline: number | null; sent: DriverSent | null },
      delivered: Delivered
    ) => deps.recordSent(target.work.id, 'queued' in delivered ? null : probe.baseline, probe.sent),
    ['deps', 'target', 'probe', 'continued']
  )
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget, message: string, now: number) => ({
      count: deps.recordContinue(target.work.id, message, now) ?? 1,
    }),
    ['deps', 'target', 'message', 'now'],
    'record'
  )
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget) => ({
      work: deps.readWork(target.work.id) ?? target.work,
    }),
    ['deps', 'target'],
    'current'
  )
  .pipe(requireNeoWorkStillContinuable, 'current', 'result:continued')
  .pipe(
    (
      deps: NeoContinueDeps,
      target: NeoContinueTarget,
      current: { work: NeoWork },
      record: { count: number },
      message: string,
      reserved: NeoAskContinueReserve
    ) => ({
      work: deps.reopen(
        target.work.id,
        current.work,
        neoContinuedReport(record.count, message, !!reserved.ask)
      ),
    }),
    ['deps', 'target', 'current', 'record', 'message', 'reserved'],
    'reopened'
  )
  .pipe(
    (deps: NeoContinueDeps, target: NeoContinueTarget) => deps.reopenAsk(target.work.id),
    ['deps', 'target']
  )
  .pipe(
    (
      deps: NeoContinueDeps,
      target: NeoContinueTarget,
      current: { work: NeoWork },
      reopened: { work: NeoWork | null }
    ) => ({
      value: {
        ok: true as const,
        work: reopened.work ?? deps.readWork(target.work.id) ?? current.work,
      },
    }),
    ['deps', 'target', 'current', 'reopened'],
    'result:continued'
  )
  .endAsync('continued') as (
  deps: NeoContinueDeps,
  target: NeoContinueTarget,
  message: string,
  now: number
) => Promise<NeoContinueResult>;
