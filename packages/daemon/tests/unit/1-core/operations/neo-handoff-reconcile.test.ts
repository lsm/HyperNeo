import { describe, expect, mock, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  decideNeoHandoffAfterRead,
  decideNeoHandoffBeforeRead,
  type NeoHandoffDeps,
  reconcileNeoHandoff,
} from '../../../../src/lib/neo/handoff-reconcile.ts';
import type { NeoDriverTargetCard } from '../../../../src/storage/repositories/neo-work-driver-target-repository.ts';

const booted = 1_000;
const ref = { adapter: 'codex-desktop', id: 'thread-1' };
const receipt = { executionId: 'thread-1', inputId: 'line-7' };
const card = (extra: Partial<NeoDriverTargetCard> = {}): NeoDriverTargetCard => ({
  target: { verb: 'start', adapter: 'codex-desktop', place: { machine: 'laptop', name: 'web' } },
  ref: null,
  followAnchor: null,
  liveStatus: null,
  startedAt: null,
  retries: 0,
  startInterrupted: false,
  needsYouSince: null,
  claimedAt: null,
  ...extra,
});
const facts = (status: NeoWork['status'], extra: Partial<NeoDriverTargetCard> = {}) => ({
  work: { status },
  card: card(extra),
  receipt,
  bootedAt: booted,
});
const status = (value: unknown) => ({ kind: 'completed' as const, value });

describe('decideNeoHandoffBeforeRead', () => {
  test('a claim from before the restart on a card that never left proposed did not start', () => {
    expect(decideNeoHandoffBeforeRead(facts('proposed', { claimedAt: booted - 5 }))).toEqual({
      state: 'not_started',
    });
  });

  test('a card handed off with no recorded worker may have started, so it stays uncertain', () => {
    expect(decideNeoHandoffBeforeRead(facts('queued', { claimedAt: booted - 5 }))).toEqual({
      state: 'uncertain',
      reason: 'no_external_identifier',
    });
    expect(decideNeoHandoffBeforeRead(facts('queued'))).toEqual({
      state: 'uncertain',
      reason: 'no_external_identifier',
    });
    expect(decideNeoHandoffBeforeRead(facts('failed', { startInterrupted: true }))).toEqual({
      state: 'uncertain',
      reason: 'start_interrupted',
    });
  });

  test('leaves a handoff of this run, an unclaimed proposal and a finished card alone', () => {
    expect(decideNeoHandoffBeforeRead(facts('queued', { claimedAt: booted + 5 }))).toEqual({
      state: 'in_flight',
    });
    expect(decideNeoHandoffBeforeRead(facts('proposed'))).toEqual({ state: 'idle' });
    expect(decideNeoHandoffBeforeRead(facts('reported'))).toEqual({ state: 'idle' });
    expect(decideNeoHandoffBeforeRead({ ...facts('queued'), work: null })).toEqual({
      state: 'idle',
    });
  });

  test('a recorded worker needs the adapter read', () => {
    expect(decideNeoHandoffBeforeRead(facts('queued', { ref }))).toBeNull();
  });
});

describe('decideNeoHandoffAfterRead', () => {
  const evidence = (state: string, echoed = receipt) =>
    status({
      ok: true,
      value: {
        status: 'running',
        lastActivityAt: 2_000,
        inputEvidence:
          state === 'observed'
            ? {
                receipt: echoed,
                state,
                exchange: [{ at: 1_500, role: 'user', text: 'Raise the font.' }],
                exchangeCut: false,
              }
            : { receipt: echoed, state },
      },
    });

  test('a started worker is reused, with its brief confirmed only by matching evidence', () => {
    expect(decideNeoHandoffAfterRead(ref, receipt, evidence('observed'))).toEqual({
      state: 'started',
      ref,
      input: 'confirmed',
    });
    expect(decideNeoHandoffAfterRead(ref, receipt, evidence('pending'))).toMatchObject({
      input: 'pending',
    });
    for (const read of [
      evidence('unavailable'),
      evidence('observed', { ...receipt, inputId: 'line-9' }),
      status({ ok: true, value: { status: 'running', lastActivityAt: 2_000 } }),
      { kind: 'failed' as const, code: 'execution_failed' as const, message: 'unreachable' },
    ])
      expect(decideNeoHandoffAfterRead(ref, receipt, read)).toMatchObject({
        state: 'started',
        input: 'unconfirmed',
      });
    expect(
      decideNeoHandoffAfterRead(
        ref,
        undefined,
        status({ ok: true, value: { status: 'done', lastActivityAt: 2_000 } })
      )
    ).toMatchObject({ state: 'started', input: 'unconfirmed' });
  });

  test('a recorded worker the adapter no longer knows is uncertain, never relaunched', () => {
    expect(
      decideNeoHandoffAfterRead(
        ref,
        receipt,
        status({ ok: false, reason: 'not_found', detail: 'gone' })
      )
    ).toEqual({ state: 'uncertain', reason: 'work_gone' });
  });
});

describe('reconcileNeoHandoff', () => {
  const work = { id: 'card-1', status: 'queued' } as NeoWork;
  const deps = (stored: NeoDriverTargetCard, read: unknown): NeoHandoffDeps => ({
    bootedAt: booted,
    readWork: () => work,
    readCard: () => stored,
    readSent: () => ({ inputBefore: 0, opening: 'Raise the font.', receipt }),
    readStatus: mock(async () => status(read)),
  });

  test("reads the recorded worker with the card's own receipt", async () => {
    const reading = deps(card({ ref }), {
      ok: true,
      value: {
        status: 'running',
        lastActivityAt: 2_000,
        inputEvidence: {
          receipt,
          state: 'observed',
          exchange: [{ at: 1_500, role: 'user', text: 'Raise the font.' }],
          exchangeCut: false,
        },
      },
    });
    expect(await reconcileNeoHandoff('card-1', reading)).toEqual({
      state: 'started',
      ref,
      input: 'confirmed',
    });
    expect(reading.readStatus).toHaveBeenCalledWith(work, ref, receipt);
  });

  test('never reads an adapter when there is no recorded worker', async () => {
    const reading = deps(card({ claimedAt: booted - 1 }), null);
    expect(await reconcileNeoHandoff('card-1', reading)).toEqual({
      state: 'uncertain',
      reason: 'no_external_identifier',
    });
    expect(reading.readStatus).not.toHaveBeenCalled();
  });
});
