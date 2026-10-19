import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { type NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import { type DriverSent, readDriverOutcome } from './driver-work.ts';
import { type NeoContinueTurn } from './card-wake.ts';

export type NeoContinueResult = { ok: true; work: NeoWork } | { ok: false; reason: string };
type Rejection = Extract<NeoContinueResult, { ok: false }>;
type Delivered = Exclude<ReturnType<typeof readDriverOutcome>, { failure: string }>;

interface NeoContinueEvidence {
  work: NeoWork | null;
  ref: WorkRef | null;
  turn: NeoContinueTurn;
  inFlight: boolean;
  ask: NeoAsk | null;
}

interface NeoContinueTarget {
  work: NeoWork;
  ref: WorkRef;
  human: boolean;
}

export interface NeoContinueCaller {
  guarded: boolean;
  human: boolean;
}

export interface NeoContinueDeps {
  readWork(id: string): NeoWork | null;
  readRef(id: string): WorkRef | null;
  readTurn(work: NeoWork, caller: NeoContinueCaller): NeoContinueTurn;
  readProgress(work: NeoWork): string;
  readAsk(id: string): NeoAsk | null;
  isContinuing(id: string): boolean;
  withGoal(id: string, message: string): string;
  readSendBaseline(
    target: NeoContinueTarget,
    message: string
  ): Promise<{ baseline: number | null; sent: DriverSent | null }>;
  send(target: NeoContinueTarget, message: string): Promise<OperationOutcome>;
  recordSent(id: string, startedAt: number | null, sent: DriverSent | null): void;
  recordContinue(id: string, message: string, now: number, progress: string): number | null;
  recordWakeContinue(work: NeoWork, human: boolean): void;
  reserveAskContinue(ask: NeoAsk): boolean;
  refundAskContinue(ask: NeoAsk): void;
  reopen(id: string, current: NeoWork, report: string): NeoWork | null;
  reopenAsk(id: string): void;
}

const reject = (reason: string): { reason: Rejection } => ({ reason: { ok: false, reason } });

export function requireNeoWorkContinuable(
  evidence: NeoContinueEvidence,
  _now: number
): { value: NeoContinueTarget } | { reason: Rejection } {
  const { work, ref, turn } = evidence;
  if (!work || !ref) return reject('Only started driver work can be continued.');
  if (work.status !== 'queued' && work.status !== 'reported')
    return reject(`This work already ${work.status}; it cannot be continued.`);
  if (evidence.inFlight)
    return reject('This work is already being continued; wait for that first.');
  return { value: { work, ref, human: turn.human } };
}

type NeoAskContinueReserve = { ask: NeoAsk | null; ok: boolean };

export function requireNeoAskContinueReserved(
  reserved: NeoAskContinueReserve
): { value: NeoAskContinueReserve } | { reason: Rejection } {
  return reserved.ok
    ? { value: reserved }
    : reject('not_approved: this ask is no longer approved; ask the human to approve it again.');
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

export function neoContinuedReport(count: number, message: string): string {
  return `Continued ${count}: ${message.slice(0, 300)}`;
}
