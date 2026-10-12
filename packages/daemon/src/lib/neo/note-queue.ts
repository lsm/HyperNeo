import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoWorkClosedDone, type NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isNeoFoldableNote } from './ask-origin.ts';

export type NeoNoteSubject = { kind: 'card' | 'ask'; id: string };
export type NeoNoteDropReason = 'settled' | 'superseded' | 'stale';
export interface NeoQueuedNote {
  uuid: string;
  seq: number;
}
export interface NeoNoteDrop {
  uuid: string;
  reason: NeoNoteDropReason;
}
export interface NeoNoteQueue {
  queued: NeoQueuedNote[];
  lastConsumedSeq: number | null;
}
export interface NeoNoteQueueDeps {
  readQueue(sessionId: string): NeoNoteQueue;
  isSettled(subject: NeoNoteSubject): boolean;
  discard(sessionId: string, drops: readonly NeoNoteDrop[]): void;
}

const SUBJECTS: ReadonlyArray<readonly [RegExp, NeoNoteSubject['kind']]> = [
  [/^neo-ask-(?:evidence|ticked):([^:]+):/, 'ask'],
  [/^neo-card-pr:([^:]+):/, 'card'],
  [/^([^:]+):(?:done-check|stall|needs-you):/, 'card'],
];

export function neoNoteSubject(messageId: string): NeoNoteSubject | null {
  for (const [pattern, kind] of SUBJECTS) {
    const id = pattern.exec(messageId)?.[1];
    if (id) return { kind, id };
  }
  return null;
}

export function isNeoWakeNote(messageId: string): boolean {
  return neoNoteSubject(messageId) !== null || isNeoFoldableNote(messageId);
}

export function isNeoNoteSubjectSettled(
  subject: NeoNoteSubject,
  work: Pick<NeoWork, 'status' | 'report'> | null,
  ask: Pick<NeoAsk, 'status'> | null
): boolean {
  if (ask && (ask.status === 'achieved' || ask.status === 'abandoned')) return true;
  return (
    subject.kind === 'card' &&
    !!work &&
    (work.status === 'cancelled' || isNeoWorkClosedDone(work.report))
  );
}

const subjectKey = (subject: NeoNoteSubject) => `${subject.kind}:${subject.id}`;

export function planNeoNoteQueue(
  queue: NeoNoteQueue,
  isSettled: (subject: NeoNoteSubject) => boolean
): NeoNoteDrop[] {
  const newest = new Map<string, number>();
  for (const note of queue.queued) {
    const subject = neoNoteSubject(note.uuid);
    if (subject) newest.set(subjectKey(subject), note.seq);
  }
  return queue.queued.flatMap((note): NeoNoteDrop[] => {
    if (!isNeoWakeNote(note.uuid)) return [];
    const subject = neoNoteSubject(note.uuid);
    if (subject && isSettled(subject)) return [{ uuid: note.uuid, reason: 'settled' }];
    if (queue.lastConsumedSeq !== null && note.seq < queue.lastConsumedSeq)
      return [{ uuid: note.uuid, reason: 'stale' }];
    if (subject && newest.get(subjectKey(subject)) !== note.seq)
      return [{ uuid: note.uuid, reason: 'superseded' }];
    return [];
  });
}

export function requireNeoNoteSubjectOpen(
  deps: NeoNoteQueueDeps,
  messageId: string
): { value: { issue: true } } | { reason: { issue: false; reason: 'settled' } } {
  const subject = neoNoteSubject(messageId);
  return subject && deps.isSettled(subject)
    ? { reason: { issue: false, reason: 'settled' } }
    : { value: { issue: true } };
}

export function withIssuedNote(queue: NeoNoteQueue, messageId: string): NeoNoteQueue {
  return {
    ...queue,
    queued: [
      ...queue.queued.filter((note) => note.uuid !== messageId),
      { uuid: messageId, seq: Number.POSITIVE_INFINITY },
    ],
  };
}

export const issueNeoNote = (superpipe({})('neo-note-issue') as PipelineAPI)
  .input(['deps', 'sessionId', 'messageId'])
  .pipe(requireNeoNoteSubjectOpen, ['deps', 'messageId'], 'result:issue')
  .pipe(
    (deps: NeoNoteQueueDeps, sessionId: string, messageId: string) =>
      withIssuedNote(deps.readQueue(sessionId), messageId),
    ['deps', 'sessionId', 'messageId'],
    'queue'
  )
  .pipe(
    (deps: NeoNoteQueueDeps, queue: NeoNoteQueue, messageId: string) =>
      planNeoNoteQueue(queue, (subject) => deps.isSettled(subject)).filter(
        (drop) => drop.uuid !== messageId
      ),
    ['deps', 'queue', 'messageId'],
    'drops'
  )
  .pipe(
    (deps: NeoNoteQueueDeps, sessionId: string, drops: NeoNoteDrop[]) =>
      deps.discard(sessionId, drops),
    ['deps', 'sessionId', 'drops']
  )
  .end('issue') as (
  deps: NeoNoteQueueDeps,
  sessionId: string,
  messageId: string
) => { issue: true } | { issue: false; reason: 'settled' };

export const dispatchNeoNote = (superpipe({})('neo-note-dispatch') as PipelineAPI)
  .input(['deps', 'sessionId', 'messageId'])
  .pipe(
    (deps: NeoNoteQueueDeps, sessionId: string) => deps.readQueue(sessionId),
    ['deps', 'sessionId'],
    'queue'
  )
  .pipe(
    (deps: NeoNoteQueueDeps, queue: NeoNoteQueue) =>
      planNeoNoteQueue(queue, (subject) => deps.isSettled(subject)),
    ['deps', 'queue'],
    'drops'
  )
  .pipe(
    (deps: NeoNoteQueueDeps, sessionId: string, drops: NeoNoteDrop[]) =>
      deps.discard(sessionId, drops),
    ['deps', 'sessionId', 'drops']
  )
  .pipe(
    (messageId: string, drops: NeoNoteDrop[]) => ({
      dispatch: !drops.some((drop) => drop.uuid === messageId),
    }),
    ['messageId', 'drops'],
    'dispatch'
  )
  .end('dispatch') as (
  deps: NeoNoteQueueDeps,
  sessionId: string,
  messageId: string
) => { dispatch: boolean };

const heldNotes = new Map<string, Map<string, number>>();

export function holdNeoNotes(sessionId: string, uuids: readonly string[]): void {
  const held = heldNotes.get(sessionId) ?? new Map<string, number>();
  for (const uuid of uuids) held.set(uuid, (held.get(uuid) ?? 0) + 1);
  heldNotes.set(sessionId, held);
}

export function releaseNeoNotes(sessionId: string, uuids: readonly string[]): void {
  const held = heldNotes.get(sessionId);
  if (!held) return;
  for (const uuid of uuids) {
    const count = (held.get(uuid) ?? 0) - 1;
    if (count > 0) held.set(uuid, count);
    else held.delete(uuid);
  }
  if (held.size === 0) heldNotes.delete(sessionId);
}

export function withoutHeldNotes(queue: NeoNoteQueue, held: ReadonlySet<string>): NeoNoteQueue {
  return { ...queue, queued: queue.queued.filter((note) => !held.has(note.uuid)) };
}

export function createNeoNoteQueueDeps(
  db: Database,
  onDiscarded: (sessionId: string, dbIds: string[]) => void = () => {}
): NeoNoteQueueDeps {
  const sdk = db.getSDKMessageRepo();
  const cards = new NeoRepository(db.getDatabase());
  const asks = new NeoAskRepository(db.getDatabase());
  return {
    readQueue: (sessionId) =>
      withoutHeldNotes(
        {
          queued: sdk.listQueuedSystemInputs(sessionId),
          lastConsumedSeq: sdk.lastConsumedInputSeq(sessionId),
        },
        new Set(heldNotes.get(sessionId)?.keys())
      ),
    isSettled: (subject) =>
      isNeoNoteSubjectSettled(
        subject,
        subject.kind === 'card' ? cards.getWork(subject.id) : null,
        subject.kind === 'card' ? asks.forWork(subject.id) : asks.get(subject.id)
      ),
    discard: (sessionId, drops) => {
      const dbIds = drops.flatMap(
        (drop) => sdk.markDeliveryFailedByUuid(sessionId, drop.uuid) ?? []
      );
      if (dbIds.length) onDiscarded(sessionId, dbIds);
    },
  };
}
