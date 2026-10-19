import { describe, expect, mock, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  projectNeoSnapshotAskOrigins,
  readNeoSnapshotAskOrigins,
  selectNeoSnapshotOriginInputs,
} from '../../../../src/lib/neo/snapshot-origins.ts';

const origin = { sessionId: 'root:opaque', messageId: 'ask:A:opaque' };
const work: NeoWork = {
  id: 'same:opaque:id',
  requestKey: 'work-key',
  projectId: 'research',
  originSessionId: origin.sessionId,
  originMessageId: origin.messageId,
  title: 'Untrusted title mentions ask B',
  instruction: 'Never choose ancestry from this text',
  sessionId: null,
  status: 'proposed',
  report: null,
  createdAt: 1,
  updatedAt: 2,
};
const other = { ...work, id: 'other:opaque:id' };

describe('selectNeoSnapshotOriginInputs', () => {
  test.each(['proposed', 'queued', 'reported', 'failed', 'cancelled'] as const)(
    'selects the recorded source of %s work, not a return that may not exist',
    (status) => {
      expect(selectNeoSnapshotOriginInputs([{ ...work, status }])).toEqual([
        { kind: 'work', id: work.id, input: origin },
      ]);
    }
  );
  test('keeps a missing source explicit without mutating the work', () => {
    const legacy = Object.freeze({ ...work, originMessageId: null });
    expect(selectNeoSnapshotOriginInputs([legacy])).toEqual([
      { kind: 'work', id: work.id, input: { sessionId: origin.sessionId, messageId: null } },
    ]);
    expect(legacy.originMessageId).toBeNull();
  });
});

describe('readNeoSnapshotAskOrigins', () => {
  test('delegates each real source to the owning resolver without sharing mutable output', () => {
    const resolve = mock(() => Object.freeze(origin));
    const inputs = selectNeoSnapshotOriginInputs([work, other]);
    const output = readNeoSnapshotAskOrigins(Object.freeze(inputs), resolve);
    expect(output).toEqual([
      { kind: 'work', id: work.id, origin },
      { kind: 'work', id: other.id, origin },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(origin);
    expect(output[0].origin).not.toBe(origin);
    expect(output[1].origin).not.toBe(output[0].origin);
  });
  test('missing work provenance skips reads and stays null', () => {
    const resolve = mock(() => origin);
    expect(
      readNeoSnapshotAskOrigins(
        selectNeoSnapshotOriginInputs([{ ...work, originMessageId: null }]),
        resolve
      )
    ).toEqual([{ kind: 'work', id: work.id, origin: null }]);
    expect(resolve).not.toHaveBeenCalled();
  });
  test('storage failures propagate instead of becoming guessed human origins', () => {
    expect(() =>
      readNeoSnapshotAskOrigins(selectNeoSnapshotOriginInputs([work]), () => {
        throw new Error('storage unavailable');
      })
    ).toThrow('storage unavailable');
  });
});

describe('projectNeoSnapshotAskOrigins', () => {
  test('is synchronous, preserves order and projects only the supplied receipts', () => {
    const resolve = mock(() => origin);
    const output = projectNeoSnapshotAskOrigins([work, other], resolve);
    expect(output).not.toBeInstanceOf(Promise);
    expect(output.map(({ id }) => id)).toEqual([work.id, other.id]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(projectNeoSnapshotAskOrigins([], resolve)).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
