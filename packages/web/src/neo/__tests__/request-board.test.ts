import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoRequestOrigin,
  projectNeoRequestSnapshot,
  scopeNeoRequestReceipts,
  selectNeoRequestSnapshot,
} from '../request-board.ts';

const origin = { sessionId: 'root', messageId: 'ask-a' };
function fixture(): NeoSnapshot {
  return {
    ok: true,
    sessionId: 'root',
    concerns: ['shared', 'other'].map((id) => ({
      id,
      title: id,
      summary: '',
      context: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    work: ['a', 'b'].map((id) => ({
      id,
      requestKey: id,
      concernId: 'shared',
      originSessionId: 'holder',
      originMessageId: 'internal-' + id,
      title: id,
      instruction: id,
      sessionId: 'worker-' + id,
      status: 'queued',
      report: null,
      createdAt: 1,
      updatedAt: 1,
    })),
    consultations: [
      {
        id: 'a',
        requestKey: 'consult-a',
        concernId: 'shared',
        originSessionId: 'root',
        originMessageId: 'ask-b',
        sessionId: 'holder',
        question: 'Unrelated B',
        status: 'pending',
        answer: null,
        createdAt: 1,
      },
    ],
    askOrigins: [
      { kind: 'work', id: 'a', origin },
      { kind: 'work', id: 'b', origin: { ...origin, messageId: 'ask-b' } },
      { kind: 'consultation', id: 'a', origin: { ...origin, messageId: 'ask-b' } },
    ],
  };
}
const message = (values: Record<string, unknown>) =>
  ({ uuid: 'msg', ...values }) as unknown as ChatMessage;

describe('request origin selection', () => {
  it('uses the human UUID in the owning transcript, not the provider session identifier', () => {
    expect(
      neoRequestOrigin(message({ type: 'user', session_id: 'provider-resume-id' }), 'root')
    ).toEqual({ sessionId: 'root', messageId: 'msg' });
  });
  it('uses explicit returned human attribution rather than internal input attribution', () => {
    expect(
      neoRequestOrigin(
        message({
          type: 'assistant',
          neoAskOrigin: origin,
          neoInputOrigin: { sessionId: 'root', messageId: 'internal' },
        }),
        'root'
      )
    ).toEqual(origin);
  });
  it.each([
    { type: 'user', inputKind: 'system' },
    { type: 'user', parent_tool_use_id: 'tool' },
    { type: 'assistant' },
    { type: 'assistant', neoAskOrigin: { ...origin, sessionId: 'other' } },
    { type: 'assistant', neoAskOrigin: { ...origin, messageId: '' } },
    { type: 'assistant', neoAskOrigin: [origin] },
    { type: 'result' },
    { type: 'user', uuid: ' ' },
  ])('leaves internal, unknown and cross-view messages unscoped: %j', (value) => {
    expect(neoRequestOrigin(message(value), 'root')).toBeNull();
  });
  it('rejects an unbound view', () => {
    expect(neoRequestOrigin(message({ type: 'user' }), '')).toBeNull();
  });
});

describe('request board projection', () => {
  it('selects actual owning metadata even when a holder receipt has internal lineage', () => {
    const snapshot = fixture();
    const before = structuredClone(snapshot);
    const selected = selectNeoRequestSnapshot(snapshot, origin);
    expect(selected).toEqual({ value: { snapshot, origin } });
    if (!('value' in selected)) throw new Error('Expected selection');
    const scoped = scopeNeoRequestReceipts(selected.value);
    expect('value' in scoped && scoped.value.work.map((row) => row.id)).toEqual(['a']);
    const result = projectNeoRequestSnapshot(snapshot, origin)!;
    expect(result.work).toEqual([snapshot.work[0]]);
    expect(result.consultations).toEqual([]);
    expect(result.concerns.map((row) => row.id)).toEqual(['shared']);
    expect(result.askOrigins).toEqual([snapshot.askOrigins![0]]);
    expect(snapshot).toEqual(before);
    expect(result).not.toBe(snapshot);
  });
  it('separates same-concern asks and overlapping IDs of different receipt kinds', () => {
    const result = projectNeoRequestSnapshot(fixture(), { ...origin, messageId: 'ask-b' })!;
    expect(result.work.map((row) => row.id)).toEqual(['b']);
    expect(result.consultations!.map((row) => row.id)).toEqual(['a']);
  });
  it.each([
    null,
    undefined,
    [],
    {},
    { ...origin, sessionId: 'holder' },
    { ...origin, messageId: ' ' },
    { ...origin, messageId: 'missing' },
  ])('never falls back to global or latest scope: %j', (value) => {
    expect(projectNeoRequestSnapshot(fixture(), value)).toBeNull();
  });
  it.each([
    undefined,
    [],
    [{ kind: 'work', id: 'a', origin: null }],
    [{ kind: 'work', id: 'a', origin: { ...origin, sessionId: 'holder' } }],
  ])('hides legacy or unresolved provenance: %j', (askOrigins) => {
    const snapshot = { ...fixture(), askOrigins } as NeoSnapshot;
    expect(projectNeoRequestSnapshot(snapshot, origin)).toBeNull();
  });
  it.each([origin, { ...origin, messageId: 'different' }, null])(
    'fails closed for duplicate or conflicting keys: %j',
    (duplicate) => {
      const snapshot = fixture();
      snapshot.askOrigins!.push({ kind: 'work', id: 'a', origin: duplicate });
      expect(projectNeoRequestSnapshot(snapshot, origin)).toBeNull();
    }
  );
  it('ignores unrelated metadata and never invents a receipt from provenance alone', () => {
    const snapshot = fixture();
    snapshot.askOrigins!.push({ kind: 'work', id: 'nonexistent', origin });
    expect(projectNeoRequestSnapshot(snapshot, origin)!.work).toHaveLength(1);
    snapshot.work = [];
    expect(projectNeoRequestSnapshot(snapshot, origin)).toBeNull();
    expect(projectNeoRequestSnapshot(null, origin)).toBeNull();
  });
});
