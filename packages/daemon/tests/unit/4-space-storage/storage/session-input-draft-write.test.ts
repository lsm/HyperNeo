import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SessionMetadata } from '@hyperneo/shared';
import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import {
  admitSessionInputDraftWrite,
  planSessionInputDraftWrite,
  sessionInputDraftSnapshotFromRow,
  type SessionInputDraftSnapshot,
} from '../../../../src/storage/repositories/session-input-draft-write.ts';

const ID = 'neo:fictional-draft-owner';
const METADATA: SessionMetadata = {
  messageCount: 2,
  totalTokens: 3,
  inputTokens: 1,
  outputTokens: 2,
  totalCost: 0,
  toolCallCount: 0,
};
const SNAPSHOT: SessionInputDraftSnapshot = {
  id: ID,
  incarnation: 1,
  draft: 'saved draft',
  voicePending: 'staged voice',
};

function session(id = ID): Session {
  return {
    id,
    title: 'Fictional draft owner',
    workspacePath: '/fictional/draft-workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: { model: 'fictional-model', maxTokens: 4096, temperature: 0.7 },
    metadata: { ...METADATA, inputDraft: SNAPSHOT.draft!, inputDraftVoicePending: 'staged voice' },
  };
}

describe('session input draft admission', () => {
  test.each(['', 'exact  \n**Markdown**', null, 'x'.repeat(DRAFT_CHAR_LIMIT)])(
    'accepts exact bounded text %s',
    (text) => {
      const admitted = admitSessionInputDraftWrite(SNAPSHOT, text);
      expect(admitted).toEqual({ value: { snapshot: SNAPSHOT, text } });
      const plan = planSessionInputDraftWrite(SNAPSHOT, text);
      expect(plan).not.toBeInstanceOf(Promise);
      expect('sql' in plan).toBe(true);
      if ('sql' in plan) {
        expect(plan.sql.match(/\?/g)?.length).toBe(plan.values.length);
        expect(plan.values).toContain(ID);
        expect(plan.values.at(-1)).toBe(SNAPSHOT.incarnation);
      }
    }
  );

  test.each([
    { id: '' },
    { id: 'x'.repeat(201) },
    { incarnation: 0 },
    { incarnation: 1.5 },
    { incarnation: Number.MAX_SAFE_INTEGER + 1 },
    { draft: 'x'.repeat(DRAFT_CHAR_LIMIT + 1) },
    { voicePending: 'x'.repeat(DRAFT_CHAR_LIMIT + 1) },
    { draft: 3 },
    { voicePending: false },
  ])('rejects invalid snapshot fields %j', (patch) => {
    const snapshot = { ...SNAPSHOT, ...patch } as SessionInputDraftSnapshot;
    expect(admitSessionInputDraftWrite(snapshot, 'edit')).toEqual({
      reason: { kind: 'invalid_input_draft_write' },
    });
    expect(planSessionInputDraftWrite(snapshot, 'edit')).toEqual({
      kind: 'invalid_input_draft_write',
    });
  });

  test.each([false, undefined, 3, 'x'.repeat(DRAFT_CHAR_LIMIT + 1)])(
    'rejects invalid replacement text %s',
    (value) => {
      expect(planSessionInputDraftWrite(SNAPSHOT, value as string)).toEqual({
        kind: 'invalid_input_draft_write',
      });
    }
  );

  test.each(['{', '[]', 'null', '3', '{"inputDraft":false}', '{"inputDraftVoicePending":3}'])(
    'refuses malformed or non-text stored metadata %s',
    (metadata) => {
      expect(sessionInputDraftSnapshotFromRow({ id: ID, incarnation: 1, metadata })).toBeNull();
    }
  );

  test('normalizes absent and explicit null draft fields without composing staged voice', () => {
    for (const metadata of ['{}', '{"inputDraft":null,"inputDraftVoicePending":null}']) {
      expect(sessionInputDraftSnapshotFromRow({ id: ID, incarnation: 1, metadata })).toEqual({
        id: ID,
        incarnation: 1,
        draft: null,
        voicePending: null,
      });
    }
    expect(
      sessionInputDraftSnapshotFromRow({
        id: ID,
        incarnation: 1,
        metadata: '{"inputDraft":"draft","inputDraftVoicePending":"voice"}',
      })
    ).toEqual({ id: ID, incarnation: 1, draft: 'draft', voicePending: 'voice' });
  });
});

describe('session input draft conditional repository write', () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    repo = new SessionRepository(db);
    repo.createSession(session());
  });
  afterEach(() => db.close());

  const row = (id = ID) =>
    db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
  const metadata = () => JSON.parse(row().metadata as string) as Record<string, unknown>;
  const capture = () => repo.captureSessionInputDraft(ID)!;

  test('captures real insertion evidence and raw draft values synchronously', () => {
    const snapshot = capture();
    expect(snapshot).not.toBeInstanceOf(Promise);
    const incarnation = repo.getSessionIncarnation(ID);
    expect(incarnation).not.toBeNull();
    expect(snapshot).toEqual({ ...SNAPSHOT, incarnation: incarnation! });
    expect(repo.captureSessionInputDraft('missing')).toBeNull();
  });

  test.each(['paused', 'pending_worktree_choice'] as const)(
    'captures and preserves a live %s owner during a guarded write',
    (status) => {
      repo.updateSession(ID, { status });
      const snapshot = repo.captureSessionInputDraft(ID);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('Expected live owner snapshot');
      const before = row();
      expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('won');
      expect(metadata()).toEqual({
        ...METADATA,
        inputDraft: 'recovered edit',
        inputDraftVoicePending: 'staged voice',
      });
      expect({ ...row(), metadata: before.metadata } as Record<string, unknown>).toEqual(before);
    }
  );

  test.each(['paused', 'pending_worktree_choice'] as const)(
    'allows a live transition to %s between capture and write',
    (status) => {
      const snapshot = capture();
      repo.updateSession(ID, { status });
      expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('won');
      expect(row().status).toBe(status);
      expect(metadata().inputDraft).toBe('recovered edit');
      expect(metadata().inputDraftVoicePending).toBe('staged voice');
    }
  );

  test.each(['paused', 'pending_worktree_choice'] as const)(
    'still refuses changed raw draft and voice values for %s',
    (status) => {
      for (const key of ['inputDraft', 'inputDraftVoicePending']) {
        repo.updateSession(ID, { status });
        const snapshot = capture();
        expect(snapshot).not.toBeNull();
        repo.updateSession(ID, { metadata: { ...METADATA, [key]: 'newer durable text' } });
        const before = row();
        expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
        expect(row()).toEqual(before);
      }
    }
  );

  test.each(['ended', 'archived'] as const)('refuses terminal status %s', (status) => {
    const snapshot = capture();
    repo.updateSession(ID, { status });
    const before = row();
    expect(repo.captureSessionInputDraft(ID)).toBeNull();
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
    expect(row()).toEqual(before);
  });

  test('refuses archived_at even when the status remains live', () => {
    const snapshot = capture();
    db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(
      '2026-10-02T00:00:00.000Z',
      ID
    );
    const before = row();
    expect(repo.captureSessionInputDraft(ID)).toBeNull();
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
    expect(row()).toEqual(before);
  });

  test.each(['123', 'true', 'false', 'null', '[]', '{"a":1}', '"quoted"', 'line\n\\path\t雪'])(
    'persists JSON-looking or escaped text literally: %s',
    (text) => {
      const before = row();
      expect(repo.casSessionInputDraft(capture(), text)).toBe('won');
      expect(metadata()).toEqual({
        ...METADATA,
        inputDraft: text,
        inputDraftVoicePending: 'staged voice',
      });
      expect(
        db
          .prepare("SELECT json_type(metadata, '$.inputDraft') AS type FROM sessions WHERE id = ?")
          .get(ID)
      ).toEqual({ type: 'text' });
      expect({ ...row(), metadata: before.metadata } as Record<string, unknown>).toEqual(before);
      const snapshot = capture();
      expect(snapshot.draft).toBe(text);
      expect(snapshot.voicePending).toBe('staged voice');
      expect(repo.casSessionInputDraft(snapshot, `${text} edited`)).toBe('won');
      expect(metadata().inputDraft).toBe(`${text} edited`);
      expect(metadata().inputDraftVoicePending).toBe('staged voice');
      expect(capture().draft).toBe(`${text} edited`);
      expect({ ...row(), metadata: before.metadata } as Record<string, unknown>).toEqual(before);
    }
  );

  test.each(['exact  \n**Markdown**', '', null])(
    'changes only the original owner inputDraft to %s',
    (text) => {
      repo.createSession(session('neo:other-owner'));
      const other = row('neo:other-owner');
      const before = row();
      const snapshot = capture();
      expect(repo.casSessionInputDraft(snapshot, text)).toBe('won');
      const after = row();
      const expected = { ...METADATA, inputDraftVoicePending: 'staged voice' };
      expect(metadata()).toEqual(text === null ? expected : { ...expected, inputDraft: text });
      expect({ ...after, metadata: before.metadata } as Record<string, unknown>).toEqual(before);
      expect(row('neo:other-owner')).toEqual(other);
    }
  );

  test.each(['inputDraft', 'inputDraftVoicePending'])(
    'refuses concurrent replacement of %s',
    (key) => {
      const snapshot = capture();
      repo.updateSession(ID, { metadata: { ...METADATA, [key]: 'newer durable text' } });
      const before = row();
      expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
      expect(row()).toEqual(before);
    }
  );

  test('refuses a concurrent clear instead of resurrecting the prior draft', () => {
    const snapshot = capture();
    repo.updateSession(ID, { metadata: { ...METADATA, inputDraft: null } });
    const before = row();
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
    expect(row()).toEqual(before);
  });

  test('preserves concurrent unrelated metadata without rejecting the guarded draft write', () => {
    const snapshot = capture();
    repo.updateSession(ID, { metadata: { ...METADATA, messageCount: 9, totalTokens: 20 } });
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('won');
    expect(metadata()).toEqual({
      ...METADATA,
      messageCount: 9,
      totalTokens: 20,
      inputDraft: 'recovered edit',
      inputDraftVoicePending: 'staged voice',
    });
  });

  test('guards the actual SQL write boundary rather than relying on a preceding read', () => {
    const plan = planSessionInputDraftWrite(capture(), 'recovered edit');
    expect('sql' in plan).toBe(true);
    if (!('sql' in plan)) throw new Error('Expected admitted SQL plan');
    const prepared = db.prepare(plan.sql);
    repo.updateSession(ID, {
      metadata: { ...METADATA, inputDraftVoicePending: 'new voice at write boundary' },
    });
    const before = row();
    expect(prepared.run(...plan.values).changes).toBe(0);
    expect(row()).toEqual(before);
  });

  test.each(['archived', 'revived', 'recreated', 'missing'])('refuses stale owner %s', (state) => {
    const snapshot = capture();
    if (state === 'archived' || state === 'revived') {
      repo.updateSession(ID, { status: 'archived' });
      if (state === 'revived') repo.updateSession(ID, { status: 'active' });
    } else {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(ID);
      if (state === 'recreated') repo.createSession(session());
    }
    const before = row();
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
    expect(row()).toEqual(before);
    if (state === 'archived' || state === 'missing') {
      expect(repo.captureSessionInputDraft(ID)).toBeNull();
    }
  });

  test.each(['[]', 'null', '{"inputDraft":3}', '{"inputDraftVoicePending":false}'])(
    'preserves invalid current metadata %s',
    (raw) => {
      repo.updateSession(ID, {
        metadata: { ...METADATA, inputDraft: null, inputDraftVoicePending: null },
      });
      const snapshot = capture();
      db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(raw, ID);
      const before = row();
      expect(repo.captureSessionInputDraft(ID)).toBeNull();
      expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
      expect(row()).toEqual(before);
    }
  );

  test('the migrated schema rejects malformed JSON without changing the current row', () => {
    const before = row();
    expect(() =>
      db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{', ID)
    ).toThrow();
    expect(row()).toEqual(before);
    expect(capture().draft).toBe(SNAPSHOT.draft);
  });

  test('an identical retry is superseded after a different replacement wins', () => {
    const snapshot = capture();
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('won');
    const before = row();
    expect(repo.casSessionInputDraft(snapshot, 'recovered edit')).toBe('superseded');
    expect(row()).toEqual(before);
  });

  test('refuses an invalid plan without touching persisted data', () => {
    const before = row();
    expect(repo.casSessionInputDraft(capture(), 'x'.repeat(DRAFT_CHAR_LIMIT + 1))).toBe('invalid');
    expect(row()).toEqual(before);
  });
});
