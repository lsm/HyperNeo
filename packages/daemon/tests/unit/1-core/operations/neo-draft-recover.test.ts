import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session, SessionMetadata } from '@hyperneo/shared';
import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import {
  captureRecoverableDraft,
  createNeoDraftRecoveryOperation,
  requireDraftRecoveryHuman,
  requireUnchangedBase,
  requireUnsubmitted,
} from '../../../../src/lib/neo/draft-recovery-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionCache } from '../../../../src/lib/session/session-cache.ts';
import { commitSessionInputDraft } from '../../../../src/lib/session/session-input-draft-commit.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import type { SessionInputDraftSnapshot } from '../../../../src/storage/repositories/session-input-draft-write.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const ROOT = `neo:${conversationId}`;
const HOLDER = 'neo:fictional-holder';
const WORKER = 'neo:fictional-worker';
const human: OperationCaller = { source: 'rpc', principal: 'local' };
let asked = 0;

function session(id: string, metadata: Partial<SessionMetadata>): Session {
  return {
    id,
    title: 'Fictional Neo draft',
    workspacePath: '/fictional/neo',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: { model: 'fictional-model', maxTokens: 4096, temperature: 0.7 },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      ...metadata,
    },
  };
}

describe('neo.draft.recover', () => {
  let sqlite: SQLite;
  let sessions: SessionRepository;
  let repo: NeoRepository;
  let asks: NeoConversationAskRepository;
  let unconditional: ReturnType<typeof mock>;
  let publish: ReturnType<typeof mock>;
  let service: {
    repo: NeoRepository;
    asks: NeoConversationAskRepository;
    sessions: SessionManager;
  };

  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    createTables(sqlite);
    sessions = new SessionRepository(sqlite);
    sessions.createSession(session(ROOT, { inputDraft: 'saved root' }));
    sessions.createSession(
      session(HOLDER, { inputDraft: 'saved holder', inputDraftVoicePending: 'staged voice' })
    );
    sessions.createSession(session(WORKER, { inputDraft: 'saved worker' }));
    repo = new NeoRepository(sqlite);
    repo.reserveBinding({ sessionId: ROOT, kind: 'neo', concernId: null });
    repo.reserveBinding({ sessionId: HOLDER, kind: 'concern', concernId: 'garden' });
    repo.reserveBinding({ sessionId: WORKER, kind: 'worker', concernId: null });
    asks = new NeoConversationAskRepository(sqlite);
    unconditional = mock(() => {});
    publish = mock(async () => {});
    const db = {
      casSessionInputDraft: (snapshot: SessionInputDraftSnapshot, text: string | null) =>
        sessions.casSessionInputDraft(snapshot, text),
    } as unknown as Database;
    const cache = { has: () => false, get: () => null } as unknown as SessionCache;
    service = {
      repo,
      asks,
      sessions: {
        captureInputDraft: (id: string) => sessions.captureSessionInputDraft(id),
        updateInputDraftIf: (snapshot: SessionInputDraftSnapshot, text: string | null) =>
          commitSessionInputDraft(snapshot, text, db, cache, publish),
        updateSession: unconditional,
      } as unknown as SessionManager,
    };
  });
  afterEach(() => sqlite.close());

  const draft = (id = ROOT) =>
    JSON.parse(
      (sqlite.prepare('SELECT metadata FROM sessions WHERE id = ?').get(id) as { metadata: string })
        .metadata
    ) as Record<string, unknown>;
  const recover = (input: unknown, caller = human) =>
    invokeOperation(
      createOperationRegistry([createNeoDraftRecoveryOperation(service)]),
      'neo.draft.recover',
      input,
      caller
    );
  function send(text: string | { type: string; text?: string }[], origin = ROOT) {
    asked += 1;
    const requestId = `20000000-0000-4000-8000-${String(asked).padStart(12, '0')}`;
    expect(
      asks.append({
        conversationId,
        requestId,
        askOrigin: { sessionId: origin, messageId: requestId },
        content: text,
      }).accepted
    ).toBe(true);
  }

  test('restores an edit made on top of the unchanged saved draft', async () => {
    expect(await recover({ sessionId: ROOT, text: 'newest edit', base: 'saved root' })).toEqual({
      kind: 'completed',
      value: { ok: true, notified: true },
    });
    expect(draft().inputDraft).toBe('newest edit');
    expect(publish).toHaveBeenCalledWith(ROOT, 'newest edit');
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('stores the trimmed draft the composer would have saved', async () => {
    await recover({ sessionId: ROOT, text: '  padded edit \n', base: 'saved root' });
    expect(draft().inputDraft).toBe('padded edit');
  });

  test('a whitespace-only edit clears the saved draft', async () => {
    expect(await recover({ sessionId: ROOT, text: '   ', base: 'saved root' })).toMatchObject({
      value: { ok: true },
    });
    expect(Object.hasOwn(draft(), 'inputDraft')).toBe(false);
  });

  test('treats an empty saved draft and a missing base as the same starting point', async () => {
    sessions.updateSession(ROOT, { metadata: { inputDraft: null } as unknown as SessionMetadata });
    expect(await recover({ sessionId: ROOT, text: 'first words', base: null })).toMatchObject({
      value: { ok: true },
    });
    expect(draft().inputDraft).toBe('first words');
    sessions.updateSession(ROOT, { metadata: { inputDraft: '' } as SessionMetadata });
    expect(await recover({ sessionId: ROOT, text: 'again', base: '' })).toMatchObject({
      value: { ok: true },
    });
  });

  test('restores a concern holder draft without consuming its staged voice', async () => {
    expect(
      await recover({ sessionId: HOLDER, text: 'holder edit', base: 'saved holder' })
    ).toMatchObject({ value: { ok: true } });
    expect(draft(HOLDER).inputDraft).toBe('holder edit');
    expect(draft(HOLDER).inputDraftVoicePending).toBe('staged voice');
    expect(draft(ROOT).inputDraft).toBe('saved root');
  });

  test('refuses when a newer draft was saved after the edit was captured', async () => {
    sessions.updateSession(ROOT, { metadata: { inputDraft: 'other tab' } as SessionMetadata });
    expect(await recover({ sessionId: ROOT, text: 'stale edit', base: 'saved root' })).toEqual({
      kind: 'completed',
      value: { ok: false, reason: 'superseded' },
    });
    expect(draft().inputDraft).toBe('other tab');
    expect(publish).not.toHaveBeenCalled();
  });

  test('refuses when the saved draft was cleared after the edit was captured', async () => {
    sessions.updateSession(ROOT, { metadata: { inputDraft: null } as unknown as SessionMetadata });
    expect(await recover({ sessionId: ROOT, text: 'sent text', base: 'saved root' })).toMatchObject(
      { value: { ok: false, reason: 'superseded' } }
    );
    expect(Object.hasOwn(draft(), 'inputDraft')).toBe(false);
  });

  test.each(['already sent', '  already sent  '])(
    'refuses to bring back the newest ask sent from this session (%j)',
    async (text) => {
      sessions.updateSession(ROOT, {
        metadata: { inputDraft: null } as unknown as SessionMetadata,
      });
      send('already sent');
      expect(await recover({ sessionId: ROOT, text, base: null })).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'submitted' },
      });
      expect(Object.hasOwn(draft(), 'inputDraft')).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    }
  );

  test('compares the text blocks of a structured ask', async () => {
    sessions.updateSession(ROOT, { metadata: { inputDraft: null } as unknown as SessionMetadata });
    send([
      { type: 'text', text: 'look at' },
      { type: 'text', text: 'this photo' },
    ]);
    expect(
      await recover({ sessionId: ROOT, text: 'look at\nthis photo', base: null })
    ).toMatchObject({ value: { ok: false, reason: 'submitted' } });
  });

  test('only the newest ask from the same session counts as submitted', async () => {
    send('older ask');
    send('newer ask');
    send('holder ask', HOLDER);
    expect(await recover({ sessionId: ROOT, text: 'older ask', base: 'saved root' })).toMatchObject(
      { value: { ok: true } }
    );
    expect(
      await recover({ sessionId: HOLDER, text: 'newer ask', base: 'saved holder' })
    ).toMatchObject({ value: { ok: true } });
  });

  test.each([
    { source: 'rpc' },
    { source: 'internal' },
    { source: 'mcp', role: 'neo', sessionId: ROOT },
  ] as OperationCaller[])(
    'refuses non-human caller %o without touching the draft',
    async (caller) => {
      expect(await recover({ sessionId: ROOT, text: 'x', base: 'saved root' }, caller)).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'human_only' },
      });
      expect(draft().inputDraft).toBe('saved root');
    }
  );

  test.each([WORKER, 'neo:unknown'])('refuses session %s', async (sessionId) => {
    expect(await recover({ sessionId, text: 'x', base: 'saved worker' })).toMatchObject({
      value: { ok: false, reason: 'session_not_found' },
    });
    expect(draft(WORKER).inputDraft).toBe('saved worker');
  });

  test('refuses a bound session whose row is gone', async () => {
    sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(HOLDER);
    expect(await recover({ sessionId: HOLDER, text: 'x', base: null })).toMatchObject({
      value: { ok: false, reason: 'session_not_found' },
    });
  });

  test.each([
    { sessionId: 'plain-session', text: 'x', base: null },
    { sessionId: ROOT, text: 'x'.repeat(DRAFT_CHAR_LIMIT + 1), base: null },
    { sessionId: ROOT, text: 'x', base: 'x'.repeat(DRAFT_CHAR_LIMIT + 1) },
    { sessionId: ROOT, text: 'x' },
    { sessionId: ROOT, text: 'x', base: null, extra: true },
  ])('rejects malformed input %#', async (input) => {
    expect(await recover(input)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(draft().inputDraft).toBe('saved root');
  });

  test('reports a committed draft whose notification failed', async () => {
    publish.mockImplementation(async () => {
      throw new Error('fictional notification failure');
    });
    expect(await recover({ sessionId: ROOT, text: 'kept', base: 'saved root' })).toEqual({
      kind: 'completed',
      value: { ok: true, notified: false },
    });
    expect(draft().inputDraft).toBe('kept');
  });

  test('a concurrent write between capture and commit loses the CAS', async () => {
    const capture = service.sessions.captureInputDraft;
    service.sessions.captureInputDraft = (id: string) => {
      const snapshot = capture(id);
      sessions.updateSession(id, { metadata: { inputDraft: 'raced' } as SessionMetadata });
      return snapshot;
    };
    expect(await recover({ sessionId: ROOT, text: 'late', base: 'saved root' })).toMatchObject({
      value: { ok: false, reason: 'superseded' },
    });
    expect(draft().inputDraft).toBe('raced');
  });

  test('a send that lands between the check and the write is cleared again', async () => {
    sessions.updateSession(ROOT, { metadata: { inputDraft: null } as unknown as SessionMetadata });
    const commit = service.sessions.updateInputDraftIf;
    let raced = false;
    service.sessions.updateInputDraftIf = (snapshot, text) => {
      if (!raced) {
        raced = true;
        send('racing send');
      }
      return commit(snapshot, text);
    };
    expect(await recover({ sessionId: ROOT, text: 'racing send', base: null })).toEqual({
      kind: 'completed',
      value: { ok: false, reason: 'submitted' },
    });
    expect(Object.hasOwn(draft(), 'inputDraft')).toBe(false);
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('a newer edit after the racing send is never cleared', async () => {
    sessions.updateSession(ROOT, { metadata: { inputDraft: null } as unknown as SessionMetadata });
    const commit = service.sessions.updateInputDraftIf;
    let calls = 0;
    service.sessions.updateInputDraftIf = async (snapshot, text) => {
      calls += 1;
      if (calls === 1) send('racing send');
      const outcome = await commit(snapshot, text);
      if (calls === 1)
        sessions.updateSession(ROOT, {
          metadata: { inputDraft: 'typed after' } as SessionMetadata,
        });
      return outcome;
    };
    expect(await recover({ sessionId: ROOT, text: 'racing send', base: null })).toMatchObject({
      value: { ok: false, reason: 'submitted' },
    });
    expect(draft().inputDraft).toBe('typed after');
    expect(calls).toBe(1);
  });

  test('pure gates compose in order', () => {
    const recovery = { sessionId: ROOT, text: 'edit', base: 'saved root' };
    expect(requireDraftRecoveryHuman(recovery, human)).toEqual({ value: recovery });
    const captured = captureRecoverableDraft(recovery, service);
    if (!('value' in captured)) throw new Error('expected capture');
    expect(captured.value.snapshot.draft).toBe('saved root');
    expect(requireUnchangedBase(captured.value)).toEqual({ value: captured.value });
    expect(
      requireUnchangedBase({ ...captured.value, recovery: { ...recovery, base: 'other' } })
    ).toEqual({ reason: { ok: false, reason: 'superseded' } });
    expect(requireUnsubmitted(captured.value, service)).toEqual({ value: captured.value });
  });
});
