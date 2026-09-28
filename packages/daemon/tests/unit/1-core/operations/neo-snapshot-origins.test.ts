import { describe, expect, mock, test } from 'bun:test';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  projectNeoSnapshotAskOrigins,
  readNeoSnapshotAskOrigins,
  selectNeoSnapshotOriginInputs,
} from '../../../../src/lib/neo/snapshot-origins.ts';

const origin = { sessionId: 'root:opaque', messageId: 'ask:A:opaque' };
const work: NeoWork = {
  id: 'same:opaque:id',
  requestKey: 'work-key',
  concernId: 'research',
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
const consultation: NeoConsultation = {
  id: work.id,
  requestKey: 'consultation-key',
  concernId: 'research',
  originSessionId: origin.sessionId,
  originMessageId: origin.messageId,
  sessionId: 'holder:research',
  question: 'Untrusted question mentions ask B',
  status: 'pending',
  answer: null,
  createdAt: 1,
};

describe('selectNeoSnapshotOriginInputs', () => {
  test.each(['proposed', 'queued', 'reported', 'failed', 'cancelled'] as const)(
    'selects the recorded source of %s work, not a return that may not exist',
    (status) => {
      expect(selectNeoSnapshotOriginInputs([{ ...work, status }], [])).toEqual([
        { kind: 'work', id: work.id, input: origin },
      ]);
    }
  );
  test('keeps distinct kind/id identities and normal pending consultation sources', () => {
    const before = JSON.stringify({ work, consultation });
    expect(
      selectNeoSnapshotOriginInputs([Object.freeze(work)], [Object.freeze(consultation)])
    ).toEqual([
      { kind: 'work', id: work.id, input: origin },
      { kind: 'consultation', id: consultation.id, input: origin },
    ]);
    expect(JSON.stringify({ work, consultation })).toBe(before);
  });
  test('null-source consultations select only their exact producer request for validation', () => {
    const id = `neo-work:${work.id}:review`;
    expect(
      selectNeoSnapshotOriginInputs([], [{ ...consultation, id, originMessageId: null }])
    ).toEqual([
      {
        kind: 'consultation',
        id,
        input: { sessionId: consultation.sessionId, messageId: `neo-consult:${id}:request` },
      },
    ]);
    expect(selectNeoSnapshotOriginInputs([{ ...work, originMessageId: null }], [])).toEqual([
      { kind: 'work', id: work.id, input: { sessionId: origin.sessionId, messageId: null } },
    ]);
  });
});

describe('readNeoSnapshotAskOrigins', () => {
  test('delegates each real source to the owning resolver without sharing mutable output', () => {
    const resolve = mock(() => Object.freeze(origin));
    const inputs = selectNeoSnapshotOriginInputs([work], [consultation]);
    const output = readNeoSnapshotAskOrigins(Object.freeze(inputs), resolve);
    expect(output).toEqual([
      { kind: 'work', id: work.id, origin },
      { kind: 'consultation', id: consultation.id, origin },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(origin);
    expect(output[0].origin).not.toBe(origin);
    expect(output[1].origin).not.toBe(output[0].origin);
  });
  test('missing work provenance skips reads and unresolved internal provenance stays null', () => {
    const resolve = mock(() => null);
    const legacy = { ...work, originMessageId: null };
    const internal = { ...consultation, originMessageId: null };
    expect(
      readNeoSnapshotAskOrigins(selectNeoSnapshotOriginInputs([legacy], [internal]), resolve)
    ).toEqual([
      { kind: 'work', id: work.id, origin: null },
      { kind: 'consultation', id: consultation.id, origin: null },
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      sessionId: internal.sessionId,
      messageId: `neo-consult:${internal.id}:request`,
    });
  });
  test('storage failures propagate instead of becoming guessed human origins', () => {
    expect(() =>
      readNeoSnapshotAskOrigins(selectNeoSnapshotOriginInputs([work], []), () => {
        throw new Error('storage unavailable');
      })
    ).toThrow('storage unavailable');
  });
});

describe('projectNeoSnapshotAskOrigins', () => {
  test('is synchronous, preserves order and projects only the supplied receipts', () => {
    const resolve = mock(() => origin);
    const output = projectNeoSnapshotAskOrigins([work], [consultation], resolve);
    expect(output).not.toBeInstanceOf(Promise);
    expect(output.map(({ kind, id }) => [kind, id])).toEqual([
      ['work', work.id],
      ['consultation', consultation.id],
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(projectNeoSnapshotAskOrigins([], [], resolve)).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
