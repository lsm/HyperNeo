import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoRequestOrigin,
  neoRequestConsultationProgress,
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

describe('queued consultation request projection', () => {
  const source = (): NeoSnapshot => {
    const snapshot = fixture();
    snapshot.work = [];
    snapshot.askOrigins = snapshot.askOrigins!.filter((row) => row.kind === 'consultation');
    snapshot.consultationWaiters = ['queued-b', 'queued-other'].map((id) => ({
      id,
      requestKey: id,
      concernId: id === 'queued-b' ? 'shared' : 'other',
      originSessionId: 'root',
      originMessageId: id === 'queued-b' ? 'ask-a' : 'ask-other',
      sessionId: id === 'queued-b' ? 'holder' : 'other-holder',
      question: id,
      status: 'queued',
      createdAt: 2,
    }));
    snapshot.askOrigins!.push(
      { kind: 'consultation', id: 'queued-b', origin },
      {
        kind: 'consultation',
        id: 'queued-other',
        origin: { ...origin, messageId: 'ask-other' },
      }
    );
    return snapshot;
  };

  it('retains a waiter-only ask without borrowing the active same-holder request', () => {
    const snapshot = source();
    const before = structuredClone(snapshot);
    const selected = selectNeoRequestSnapshot(snapshot, origin);
    if ('reason' in selected) throw new Error('Expected selection');
    const scoped = scopeNeoRequestReceipts(selected.value);
    expect(scoped).toHaveProperty('value');
    const result = projectNeoRequestSnapshot(snapshot, origin)!;
    expect(result.consultationWaiters).toEqual([snapshot.consultationWaiters![0]]);
    expect(result.consultations).toEqual([]);
    expect(result.work).toEqual([]);
    expect(result.concerns.map((row) => row.id)).toEqual(['shared']);
    expect(result.askOrigins).toEqual([{ kind: 'consultation', id: 'queued-b', origin }]);
    expect(neoRequestConsultationProgress(result)).toEqual([
      { id: 'queued-b', status: 'queued', label: 'Waiting for shared’s context…' },
    ]);
    expect(snapshot).toEqual(before);
  });

  it.each(['admitted', 'cancelled'] as const)(
    'does not present a %s waiter as queued',
    (status) => {
      const snapshot = source();
      snapshot.consultationWaiters![0].status = status;
      expect(projectNeoRequestSnapshot(snapshot, origin)).toBeNull();
      expect(neoRequestConsultationProgress(snapshot).map((row) => row.id)).not.toContain(
        'queued-b'
      );
    }
  );

  it.each([undefined, [], [{ kind: 'consultation', id: 'queued-b', origin: null }]])(
    'keeps missing waiter attribution fail-closed: %j',
    (askOrigins) => {
      expect(
        projectNeoRequestSnapshot({ ...source(), askOrigins } as NeoSnapshot, origin)
      ).toBeNull();
    }
  );

  it.each([origin, { ...origin, messageId: 'ask-other' }, null])(
    'rejects duplicate waiter attribution rather than borrowing a nearby ask: %j',
    (duplicate) => {
      const snapshot = source();
      snapshot.askOrigins!.push({ kind: 'consultation', id: 'queued-b', origin: duplicate });
      expect(projectNeoRequestSnapshot(snapshot, origin)).toBeNull();
    }
  );

  it('keeps the receipt identity on promotion and tolerates a transient duplicate waiter', () => {
    const snapshot = source();
    const waiter = snapshot.consultationWaiters![0];
    snapshot.consultations!.push({ ...waiter, status: 'pending', answer: null });
    const result = projectNeoRequestSnapshot(snapshot, origin)!;
    expect(result.consultationWaiters).toEqual([]);
    expect(result.consultations!.map((row) => row.id)).toEqual(['queued-b']);
    expect(neoRequestConsultationProgress(result)).toEqual([
      { id: 'queued-b', status: 'pending', label: 'Checking shared’s context…' },
    ]);
    expect(
      neoRequestConsultationProgress(snapshot).filter((row) => row.id === waiter.id)
    ).toHaveLength(1);
  });

  it.each(['reported', 'failed'] as const)(
    'removes inline progress on %s without inventing a result',
    (status) => {
      const snapshot = source();
      const waiter = snapshot.consultationWaiters![0];
      snapshot.consultations!.push({ ...waiter, status, answer: null });
      expect(neoRequestConsultationProgress(projectNeoRequestSnapshot(snapshot, origin))).toEqual(
        []
      );
    }
  );

  it('uses a generic context label when the bounded snapshot has no concern detail', () => {
    const snapshot = source();
    snapshot.concerns = [];
    expect(neoRequestConsultationProgress(projectNeoRequestSnapshot(snapshot, origin))).toEqual([
      { id: 'queued-b', status: 'queued', label: 'Waiting for context…' },
    ]);
    expect(neoRequestConsultationProgress(null)).toEqual([]);
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
