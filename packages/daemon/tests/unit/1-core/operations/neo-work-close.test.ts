import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE } from '@hyperneo/shared/types/neo-snapshot';
import {
  closeNeoWork,
  planNeoWorkClose,
  requireNeoWorkClosed,
  type NeoWorkCloseDeps,
} from '../../../../src/lib/neo/work-close.ts';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';

const base: NeoWork = Object.freeze({
  id: 'work-1',
  requestKey: 'root:k',
  originSessionId: 'root',
  originMessageId: 'm1',
  concernId: null,
  title: 'Title',
  instruction: 'Do it.',
  targetSessionId: null,
  sessionId: null,
  status: 'queued',
  report: null,
  createdAt: 1,
  updatedAt: 1,
});
const at = (status: NeoWork['status']): NeoWork => ({ ...base, status });

describe('planNeoWorkClose', () => {
  test.each([
    ['cancelled', 'cancelled', { reason: { ok: true, work: at('cancelled') } }],
    [
      'cancelled',
      'done',
      { reason: { ok: false, reason: 'work_closed: cancelled work stays cancelled' } },
    ],
    ['reported', 'done', { reason: { ok: true, work: at('reported') } }],
  ] as const)('%s work closed as %s settles without a write', (status, outcome, expected) => {
    expect(planNeoWorkClose(at(status), outcome)).toEqual(expected);
  });

  test('missing work is not found', () => {
    expect(planNeoWorkClose(null, 'done')).toEqual({
      reason: { ok: false, reason: 'work_not_found' },
    });
  });

  test.each([
    ['proposed', 'cancelled', { status: 'cancelled' }, true],
    ['queued', 'cancelled', { status: 'cancelled' }, true],
    ['queued', 'done', { status: 'reported', report: NEO_WORK_CLOSED_DONE }, true],
    ['failed', 'done', { status: 'reported', report: NEO_WORK_CLOSED_DONE }, false],
    ['reported', 'cancelled', { status: 'cancelled' }, false],
  ] as const)(
    '%s work closed as %s writes %j, stopping the driver: %s',
    (status, outcome, patch, stop) => {
      expect(planNeoWorkClose(at(status), outcome)).toEqual({
        value: { work: at(status), patch, stopDriver: stop },
      });
    }
  );
});

describe('requireNeoWorkClosed', () => {
  test('a lost transition race asks the caller to read again', () => {
    expect(requireNeoWorkClosed({ work: null })).toEqual({
      reason: { ok: false, reason: 'This work changed meanwhile; read it again.' },
    });
    expect(requireNeoWorkClosed({ work: at('cancelled') })).toEqual({
      value: { ok: true, work: at('cancelled') },
    });
  });
});

describe('closeNeoWork', () => {
  const ref: WorkRef = { adapter: 'codex-desktop', id: 'thread-1' };
  const harness = (current: NeoWork | null, transitioned: NeoWork | null) => {
    const stops: Array<[WorkRef, NeoWork]> = [];
    const writes: unknown[] = [];
    const deps: NeoWorkCloseDeps = {
      repo: {
        getWork: () => current,
        transitionWork: (_id, _expected, patch) => {
          writes.push(patch);
          return transitioned;
        },
      },
      readDriverRef: () => ref,
      stopDriver: async (stopRef, work) => {
        stops.push([stopRef, work]);
      },
    };
    return { deps, stops, writes };
  };

  test('cancelling queued work writes the cancel and stops the driver with the closed work', async () => {
    const { deps, stops, writes } = harness(at('queued'), at('cancelled'));
    expect(await closeNeoWork(deps, 'work-1', 'cancelled')).toEqual({
      ok: true,
      work: at('cancelled'),
    });
    expect(writes).toEqual([{ status: 'cancelled' }]);
    expect(stops).toEqual([[ref, at('cancelled')]]);
  });

  test('closing failed work as done records the report and leaves the driver alone', async () => {
    const reported = { ...at('reported'), report: NEO_WORK_CLOSED_DONE };
    const { deps, stops } = harness(at('failed'), reported);
    expect(await closeNeoWork(deps, 'work-1', 'done')).toEqual({ ok: true, work: reported });
    expect(stops).toEqual([]);
  });

  test('a lost race neither reports success nor stops the driver', async () => {
    const { deps, stops } = harness(at('queued'), null);
    expect(await closeNeoWork(deps, 'work-1', 'cancelled')).toEqual({
      ok: false,
      reason: 'This work changed meanwhile; read it again.',
    });
    expect(stops).toEqual([]);
  });

  test('already-cancelled work settles without a write', async () => {
    const { deps, stops, writes } = harness(at('cancelled'), null);
    expect(await closeNeoWork(deps, 'work-1', 'cancelled')).toEqual({
      ok: true,
      work: at('cancelled'),
    });
    expect(writes).toEqual([]);
    expect(stops).toEqual([]);
  });
});
