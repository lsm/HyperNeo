import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import {
  buildSessionRuntimeSettingsWrite,
  planRuntimeSettingsPatch,
} from '../../../../src/storage/repositories/session-runtime-settings-write.ts';

const ID = 'fictional-session';
const ACP_KEYS = ['acpContextUsageEstimate', 'acpSessionCommand'];
const EVIDENCE_INSERT = 'INSERT INTO session_incarnations (incarnation, session_id) VALUES (?, ?)';

const CONFIG: SessionConfig = {
  model: 'fictional-model',
  provider: 'anthropic',
  thinkingLevel: 'off',
  maxTokens: 4096,
  temperature: 0.7,
  providerConfig: { apiKey: 'fictional-key' },
};

const METADATA: SessionMetadata = {
  messageCount: 7,
  totalTokens: 11,
  inputTokens: 5,
  outputTokens: 6,
  totalCost: 0.42,
  toolCallCount: 2,
  acpContextUsageEstimate: 4242,
  acpSessionCommand: 'fictional-acp --stdio',
};

function session(id = ID): Session {
  return {
    id,
    title: 'Fictional session',
    workspacePath: '/fictional/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: CONFIG,
    metadata: METADATA,
    type: 'space_task_agent',
    context: { spaceId: 'space-1', taskId: 'task-1' },
    parentSessionId: 'parent-1',
    processingState: JSON.stringify({ status: 'idle' }),
    sdkSessionId: 'fictional-sdk',
    acpSessionId: 'fictional-acp',
    sdkOriginPath: '/fictional/origin',
    worktree: { isWorktree: true, worktreePath: '/wt', mainRepoPath: '/repo', branch: 'br' },
  };
}

describe('session runtime settings capture and conditional write', () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    repo = new SessionRepository(db);
  });
  afterEach(() => db.close());

  function row(id = ID): Record<string, unknown> {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
  }
  function storedConfig(id = ID): Record<string, unknown> {
    return JSON.parse(row(id).config as string) as Record<string, unknown>;
  }
  function storedMetadata(id = ID): Record<string, unknown> {
    return JSON.parse(row(id).metadata as string) as Record<string, unknown>;
  }
  const capture = (id = ID) => repo.captureSessionRuntimeSettings(id);

  function run(sql: string, ...params: unknown[]) {
    return db.prepare(sql).run(...params);
  }
  function setColumn(column: string, value: unknown, id = ID) {
    return run(`UPDATE sessions SET ${column} = ? WHERE id = ?`, value, id);
  }
  const cas = (
    patch: Parameters<SessionRepository['casSessionRuntimeSettings']>[1],
    snapshot = capture()!
  ) => repo.casSessionRuntimeSettings(snapshot, patch);

  test('capture returns null for a missing target and real evidence for a real row', () => {
    expect(capture('absent')).toBeNull();
    repo.createSession(session());
    const snapshot = capture();
    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toBeInstanceOf(Promise);
    expect(snapshot?.incarnation).toBe(repo.getSessionIncarnation(ID));
    expect(snapshot?.id).toBe(ID);
    expect(storedConfig()).toEqual(CONFIG);
    expect(JSON.parse(snapshot?.config ?? '')).toEqual(CONFIG);
    expect(JSON.parse(snapshot?.metadata ?? '')).toEqual(METADATA);
    expect(JSON.parse(snapshot?.sessionContext ?? '')).toEqual({
      spaceId: 'space-1',
      taskId: 'task-1',
    });
    expect(snapshot?.status).toBe('active');
    expect(snapshot?.type).toBe('space_task_agent');
    expect(snapshot?.parentId).toBe('parent-1');
    expect(snapshot?.workspacePath).toBe('/fictional/workspace');
    expect(snapshot?.isWorktree).toBe(1);
    expect(snapshot?.sdkSessionId).toBe('fictional-sdk');
    expect(snapshot?.acpSessionId).toBe('fictional-acp');
    expect(snapshot?.sdkOriginPath).toBe('/fictional/origin');
  });

  test('the builder binds every SET value before the id and guard parameters', () => {
    repo.createSession(session());
    const snapshot = capture()!;
    const plan = planRuntimeSettingsPatch({ model: 'next-model', provider: 'glm' });
    const write = buildSessionRuntimeSettingsWrite(snapshot, plan);
    expect(write.sql.match(/\?/g)).toHaveLength(20);
    expect(write.values.slice(0, 2)).toEqual(['next-model', 'glm']);
    expect(write.values[2]).toBe(ID);
    expect(write.values[3]).toBe(snapshot.config);
    expect(write.values.at(-1)).toBe(snapshot.incarnation);
    expect(write.sql.indexOf('json_set')).toBeLessThan(write.sql.indexOf('WHERE id = ?'));
  });

  test('a narrow model patch wins and preserves every unrelated config and metadata value', () => {
    repo.createSession(session());
    expect(cas({ model: 'next-model' })).toBe('won');
    expect(storedConfig()).toEqual({ ...CONFIG, model: 'next-model' });
    expect(storedMetadata()).toEqual(METADATA);
  });

  test('a provider and thinking patch is one statement and preserves unrelated config values', () => {
    repo.createSession(session());
    expect(cas({ provider: 'glm', thinkingLevel: 'think16k' })).toBe('won');
    expect(storedConfig()).toEqual({
      ...CONFIG,
      provider: 'glm',
      thinkingLevel: 'think16k',
    });
    expect(row().sdk_session_id).toBe('fictional-sdk');
  });

  test('the ACP identity clear removes both ACP metadata keys and nothing else', () => {
    repo.createSession(session());
    expect(cas({ model: 'x', clearAcpSession: true })).toBe('won');
    expect(row().acp_session_id).toBeNull();
    expect(storedMetadata()).toEqual(
      Object.fromEntries(Object.entries(METADATA).filter(([key]) => !ACP_KEYS.includes(key)))
    );
    expect(row().sdk_session_id).toBe('fictional-sdk');
    expect(row().sdk_origin_path).toBe('/fictional/origin');
  });

  test('the SDK identity clear removes both SDK columns and leaves the ACP identity intact', () => {
    repo.createSession(session());
    expect(cas({ model: 'x', clearSdkSession: true })).toBe('won');
    expect(row().sdk_session_id).toBeNull();
    expect(row().sdk_origin_path).toBeNull();
    expect(row().acp_session_id).toBe('fictional-acp');
    expect(storedMetadata()).toEqual(METADATA);
  });

  test('reusing a spent snapshot is superseded instead of applied twice', () => {
    repo.createSession(session());
    const snapshot = capture()!;
    expect(cas({ model: 'next-model' }, snapshot)).toBe('won');
    expect(cas({ model: 'third-model' }, snapshot)).toBe('superseded');
    expect(storedConfig().model).toBe('next-model');
  });

  test('a same-id delete and recreate with identical bytes is superseded, not written', () => {
    repo.createSession(session());
    const snapshot = capture()!;
    const original = row();
    run('DELETE FROM sessions WHERE id = ?', ID);
    repo.createSession(session());
    expect(row()).toEqual(original);
    expect(cas({ model: 'next-model' }, snapshot)).toBe('superseded');
    expect(storedConfig().model).toBe('fictional-model');
  });

  const DRIFT: ReadonlyArray<readonly [string, unknown]> = [
    ['config', '{"model":"drifted"}'],
    ['metadata', '{"messageCount":9}'],
    ['session_context', '{"spaceId":"space-2"}'],
    ['status', 'paused'],
    ['type', 'space_chat'],
    ['archived_at', '2026-02-02T00:00:00.000Z'],
    ['processing_state', '{"status":"processing"}'],
    ['parent_id', 'parent-2'],
    ['workspace_path', '/other/workspace'],
    ['is_worktree', 0],
    ['worktree_path', '/other/wt'],
    ['main_repo_path', '/other/repo'],
    ['worktree_branch', 'other-branch'],
    ['sdk_session_id', 'other-sdk'],
    ['acp_session_id', 'other-acp'],
    ['sdk_origin_path', '/other/origin'],
  ];

  test.each(DRIFT)('%s drift is superseded and the row stays byte identical', (column, value) => {
    repo.createSession(session());
    const snapshot = capture()!;
    const before = row()[column];
    setColumn(column, value);
    const drifted = row();
    expect(drifted[column]).not.toEqual(before);
    expect(cas({ model: 'next-model' }, snapshot)).toBe('superseded');
    expect(row()).toEqual(drifted);
  });

  test('a null-owned row writes when nothing drifts and refuses once ownership appears', () => {
    const bare = session('bare');
    bare.workspacePath = null;
    bare.parentSessionId = null;
    for (const key of ['context', 'worktree', 'sdkSessionId', 'acpSessionId', 'sdkOriginPath'])
      Reflect.deleteProperty(bare, key);
    repo.createSession(bare);
    const snapshot = capture('bare')!;
    expect(snapshot.parentId).toBeNull();
    expect(snapshot.workspacePath).toBeNull();
    expect(snapshot.sessionContext).toBeNull();
    expect(snapshot.sdkSessionId).toBeNull();
    expect(cas({ model: 'next-model' }, snapshot)).toBe('won');
    expect(storedConfig('bare').model).toBe('next-model');
    const second = capture('bare')!;
    setColumn('parent_id', 'late-parent', 'bare');
    expect(cas({ model: 'late-model' }, second)).toBe('superseded');
    expect(storedConfig('bare').model).toBe('next-model');
  });

  test('a deleted row is superseded rather than resurrected or faulted', () => {
    repo.createSession(session());
    const snapshot = capture()!;
    run('DELETE FROM sessions WHERE id = ?', ID);
    expect(cas({ model: 'next-model' }, snapshot)).toBe('superseded');
    expect(capture()).toBeNull();
  });

  test('a rolled back transaction leaves no residue for a later conditional write', () => {
    repo.createSession(session());
    const snapshot = capture()!;
    expect(() =>
      db.transaction(() => {
        expect(cas({ model: 'rolled-back' }, snapshot)).toBe('won');
        throw new Error('rollback');
      })()
    ).toThrow('rollback');
    expect(storedConfig().model).toBe('fictional-model');
    expect(cas({ model: 'next-model' })).toBe('won');
    expect(storedConfig().model).toBe('next-model');
  });

  test('missing insertion evidence is a thrown fault while the target still exists', () => {
    repo.createSession(session());
    expect(run('DELETE FROM session_incarnations WHERE session_id = ?', ID).changes).toBe(1);
    expect(row().config).toBe(JSON.stringify(CONFIG));
    expect(() => capture()).toThrow('missing insertion evidence');
  });

  test('a recreated evidence row with an invalid integer is rejected by the real getter', () => {
    repo.createSession(session());
    run('DELETE FROM session_incarnations WHERE session_id = ?', ID);
    run(EVIDENCE_INSERT, 0, ID);
    expect(() => capture()).toThrow('missing insertion evidence');
    expect(() => repo.getSessionIncarnation(ID)).toThrow('Invalid session incarnation');
    run('DELETE FROM session_incarnations WHERE session_id = ?', ID);
    run(EVIDENCE_INSERT, -5, ID);
    expect(() => capture()).toThrow('missing insertion evidence');
    expect(() => run(EVIDENCE_INSERT, 1.5, ID)).toThrow('datatype mismatch');
  });

  test('evidence that vanishes or is replaced after capture is a fault or superseded', () => {
    repo.createSession(session());
    const missing = capture()!;
    run('DELETE FROM session_incarnations WHERE session_id = ?', ID);
    expect(row().config).toBe(JSON.stringify(CONFIG));
    expect(() => cas({ model: 'next-model' }, missing)).toThrow('Invalid session incarnation');
    expect(run(EVIDENCE_INSERT, 90, ID).changes).toBe(1);
    const captured = capture()!;
    expect(captured.incarnation).toBe(90);
    run('DELETE FROM sessions WHERE id = ?', ID);
    repo.createSession(session());
    expect(repo.getSessionIncarnation(ID)).toBeGreaterThan(captured.incarnation);
    expect(cas({ model: 'next-model' }, captured)).toBe('superseded');
    expect(storedConfig().model).toBe('fictional-model');
  });

  test('a database without insertion evidence throws instead of degrading to superseded', () => {
    repo.createSession(session());
    db.exec('DROP TABLE session_incarnations');
    expect(() => capture()).toThrow();
  });

  test('corrupt storage faults in capture or in storage itself, never silently', () => {
    repo.createSession(session());
    setColumn('config', 'not json');
    expect(() => capture()).toThrow('config is not a JSON object');
    setColumn('config', '[1,2]');
    expect(() => capture()).toThrow('config is not a JSON object');
    setColumn('config', JSON.stringify(CONFIG));
    setColumn('metadata', '[1,2]');
    expect(() => capture()).toThrow('metadata is not a JSON object');
    expect(() => setColumn('metadata', '{"unclosed":')).toThrow('malformed JSON');
    expect(() => run('UPDATE sessions SET status = NULL WHERE id = ?', ID)).toThrow(
      'NOT NULL constraint failed'
    );
    expect(storedConfig()).toEqual(CONFIG);
  });
});

describe('runtime settings patch plan', () => {
  const NONE = { clearAcpMetadata: false, clearAcpSession: false, clearSdkSession: false };
  const entries = (patch: Parameters<typeof planRuntimeSettingsPatch>[0]) =>
    planRuntimeSettingsPatch(patch).configEntries;

  test('plans only the requested config paths in declaration order', () => {
    expect(entries({ thinkingLevel: 'think8k', model: 'm' })).toEqual([
      ['$.model', 'm'],
      ['$.thinkingLevel', 'think8k'],
    ]);
    expect(entries({ provider: 'glm' })).toEqual([['$.provider', 'glm']]);
  });

  test('treats the ACP clear as primitive mechanics and the SDK clear as independent', () => {
    expect(planRuntimeSettingsPatch({ model: 'm' })).toMatchObject(NONE);
    expect(planRuntimeSettingsPatch({ model: 'm', clearAcpSession: true })).toMatchObject({
      ...NONE,
      clearAcpMetadata: true,
      clearAcpSession: true,
    });
    expect(planRuntimeSettingsPatch({ model: 'm', clearSdkSession: true })).toMatchObject({
      ...NONE,
      clearSdkSession: true,
    });
  });

  test('refuses a patch with no settings and a patch with an empty value', () => {
    expect(() => planRuntimeSettingsPatch({})).toThrow('nothing to write');
    expect(() => planRuntimeSettingsPatch({ clearAcpSession: true })).toThrow('nothing to write');
    expect(() => planRuntimeSettingsPatch({ model: '' })).toThrow(
      'model must be a non-empty string'
    );
    expect(() => planRuntimeSettingsPatch({ thinkingLevel: '' })).toThrow(
      'thinkingLevel must be a non-empty string'
    );
  });
});
