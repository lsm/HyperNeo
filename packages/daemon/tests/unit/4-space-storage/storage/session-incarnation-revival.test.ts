import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { SessionLifecycle } from '../../../../src/lib/session/session-lifecycle.ts';
import { DatabaseCore } from '../../../../src/storage/database-core.ts';
import { Database as SqliteDatabase } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';

function session(id: string, status: Session['status'] = 'active'): Session {
  return {
    id,
    title: 'Fictional session',
    workspacePath: '/fictional/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status,
    config: {
      model: 'fictional-model',
      provider: 'anthropic',
      thinkingLevel: 'off',
      maxTokens: 4096,
      temperature: 0.7,
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      ...(status === 'pending_worktree_choice'
        ? { worktreeChoice: { status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' } }
        : {}),
    },
    type: 'worker',
  };
}

function revivalTriggerCount(db: SqliteDatabase): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'sessions_incarnation_revive'"
    )
    .get() as { count: number };
  return row.count;
}

describe('session incarnation revival', () => {
  test('fresh and already-m290 databases install one trigger on initialization and reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fictional-session-incarnation-revival-'));
    const path = join(directory, 'daemon.db');
    let core: DatabaseCore | undefined;
    try {
      core = new DatabaseCore(path);
      await core.initialize();
      const db = core.getDb();
      expect(revivalTriggerCount(db)).toBe(1);
      const marker = db
        .prepare("SELECT applied_at FROM migration_markers WHERE key = 'migration_290'")
        .get();
      expect(marker).toBeTruthy();
      const repo = new SessionRepository(db);
      repo.createSession(session('revival-parity'));
      const incarnation = repo.getSessionIncarnation('revival-parity');
      expect(incarnation).toBeGreaterThan(0);
      core.close();
      core = undefined;

      const legacy = new SqliteDatabase(path);
      legacy.exec('DROP TRIGGER sessions_incarnation_revive');
      expect(
        legacy.prepare("SELECT 1 FROM migration_markers WHERE key = 'migration_290'").get()
      ).toBeTruthy();
      legacy.close();

      core = new DatabaseCore(path);
      await core.initialize();
      const upgradedDb = core.getDb();
      expect(revivalTriggerCount(upgradedDb)).toBe(1);
      expect(
        upgradedDb
          .prepare("SELECT applied_at FROM migration_markers WHERE key = 'migration_290'")
          .get()
      ).toEqual(marker);
      expect(new SessionRepository(upgradedDb).getSessionIncarnation('revival-parity')).toBe(
        incarnation
      );
      createTables(upgradedDb);
      expect(revivalTriggerCount(upgradedDb)).toBe(1);
      expect(new SessionRepository(upgradedDb).getSessionIncarnation('revival-parity')).toBe(
        incarnation
      );
    } finally {
      core?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('archive then restore of identical raw row spends the captured CAS without changing it', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      createTables(db);
      const repo = new SessionRepository(db);
      repo.createSession(session('revival-aba'));
      const captured = repo.captureSessionRuntimeSettings('revival-aba')!;
      const originalRow = db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get('revival-aba') as Record<string, unknown>;
      const originalSession = repo.getSession('revival-aba');
      db.prepare("UPDATE sessions SET status = 'archived', archived_at = ? WHERE id = ?").run(
        '2026-02-01T00:00:00.000Z',
        'revival-aba'
      );
      expect(repo.getSessionIncarnation('revival-aba')).toBe(captured.incarnation);
      db.prepare('UPDATE sessions SET status = ?, archived_at = ? WHERE id = ?').run(
        originalRow.status,
        originalRow.archived_at,
        'revival-aba'
      );
      expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('revival-aba')).toEqual(
        originalRow
      );
      expect(repo.getSessionIncarnation('revival-aba')).toBeGreaterThan(captured.incarnation);
      expect(repo.casSessionRuntimeSettings(captured, { model: 'must-not-write' })).toBe(
        'superseded'
      );
      expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('revival-aba')).toEqual(
        originalRow
      );
      expect(repo.getSession('revival-aba')).toEqual(originalSession);
    } finally {
      db.close();
    }
  });

  test('ordinary settings updates and archiving alone retain the incarnation', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      createTables(db);
      const repo = new SessionRepository(db);
      repo.createSession(session('no-revival'));
      const incarnation = repo.getSessionIncarnation('no-revival');
      repo.updateSession('no-revival', {
        status: 'paused',
        config: {
          model: 'other-model',
          provider: 'anthropic',
          thinkingLevel: 'off',
          maxTokens: 4096,
          temperature: 0.7,
        },
        metadata: {
          messageCount: 2,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
      });
      expect(repo.getSessionIncarnation('no-revival')).toBe(incarnation);
      repo.updateSession('no-revival', { status: 'archived' });
      expect(repo.getSessionIncarnation('no-revival')).toBe(incarnation);
    } finally {
      db.close();
    }
  });

  test('deferred worktree choice that revives an archived row advances its incarnation', async () => {
    const db = new SqliteDatabase(':memory:');
    try {
      createTables(db);
      const repo = new SessionRepository(db);
      repo.createSession(session('deferred-revival', 'pending_worktree_choice'));
      const initialIncarnation = repo.getSessionIncarnation('deferred-revival');
      let finishBranch!: (branch: string | null) => void;
      let branchRequested = false;
      const branchResult = new Promise<string | null>((resolve) => {
        finishBranch = resolve;
      });
      const agentSession = {
        getSessionData: () => repo.getSession('deferred-revival')!,
        updateMetadata: () => {},
      };
      const lifecycle = new SessionLifecycle(
        {
          updateSession: (id: string, updates: Partial<Session>) => repo.updateSession(id, updates),
        } as never,
        {
          getCurrentBranch: () => {
            branchRequested = true;
            return branchResult;
          },
        } as never,
        { get: () => agentSession } as never,
        { publish: async () => {} } as never,
        {} as never,
        { defaultModel: 'fictional-model', maxTokens: 4096, temperature: 0.7 },
        {} as never,
        (() => agentSession) as never
      );
      const completion = lifecycle.completeWorktreeChoice('deferred-revival', 'direct');
      expect(branchRequested).toBe(true);
      repo.updateSession('deferred-revival', {
        status: 'archived',
        archivedAt: '2026-02-01T00:00:00.000Z',
      });
      const archivedIncarnation = repo.getSessionIncarnation('deferred-revival');
      expect(archivedIncarnation).toBe(initialIncarnation);
      finishBranch('main');
      expect((await completion).status).toBe('active');
      expect(repo.getSession('deferred-revival')?.status).toBe('active');
      expect(repo.getSessionIncarnation('deferred-revival')).toBeGreaterThan(archivedIncarnation!);
    } finally {
      db.close();
    }
  });
});
