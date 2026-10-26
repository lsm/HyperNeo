import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { loadRegistrationBinding } from '../../../../src/lib/artifacts/registration-binding.ts';
import {
  authorizeArtifactCaller,
  resolveArtifactSource,
} from '../../../../src/lib/artifacts/file-policy.ts';

let db: Database;
let native: Database;
let root: string;
let home: string;
let workspace: string;
let sessions: NeoTodoSessionRepository;
const context = { kind: 'todo' as const, id: 'todo' };
const load = () => loadRegistrationBinding(db, 'daemon', context, home);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-artifact-binding-')));
  home = join(root, 'home');
  workspace = join(root, 'actual-worktree');
  mkdirSync(join(home, '.codex'), { recursive: true });
  native = new Database(join(home, '.codex', 'state_5.sqlite'));
  native.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, source TEXT)');
  native.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('worker', workspace, 'cli');
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const work = new NeoAskTodoRepository(db);
  work.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm',
    title: 'Synthetic',
    request: 'Synthetic',
    createdAt: 1,
  });
  work.addTodo(
    'todo',
    'ask',
    { title: 'Report', doneWhen: '', check: null, instruction: '', named: null },
    1
  );
  db.prepare(
    "INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('neo','Neo',?,'now','now','active','{}','{}')"
  ).run(join(root, 'neo-workspace'));
  sessions = new NeoTodoSessionRepository(db);
  sessions.create('todo', {
    verb: 'start',
    adapter: 'codex-desktop',
    place: { machine: 'local', name: 'Grouped project', folder: join(root, 'wrong-project') },
  });
  sessions.recordRef('todo', { adapter: 'codex-desktop', id: 'worker' });
});

afterEach(() => {
  native.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('native artifact workspace ownership', () => {
  test('keeps custom-home capture and owned snapshot reads working during native locks', () => {
    const proof = join(root, 'proof');
    mkdirSync(join(proof, 'home'), { recursive: true });
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/native-artifact-register.ts',
            import.meta.url
          )
        ),
        proof,
      ],
      {
        cwd: fileURLToPath(new URL('../../../../../..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: join(proof, 'home'),
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(proof, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    expect(
      JSON.parse(readFileSync(join(proof, 'evidence/native-registration.json'), 'utf8'))
    ).toMatchObject({
      passed: true,
      customHomeConsistent: true,
      snapshotReadsUnderNativeLock: true,
      revocationUnderNativeLock: true,
    });
  });

  test('binds only the native thread cwd and preserves producer identity', () => {
    expect(load()).toMatchObject({
      workspacePath: workspace,
      workerSessionId: 'codex-desktop:worker',
      workerRef: { adapter: 'codex-desktop', id: 'worker' },
    });
    const binding = load()!;
    const deps = { daemonId: 'daemon', home, loadBinding: load };
    expect(resolveArtifactSource(binding, 'report.md', deps)).toMatchObject({
      value: { root: workspace, relativePath: 'report.md' },
    });
    expect(resolveArtifactSource(binding, join(root, 'wrong-project', 'report.md'), deps)).toEqual({
      value: { context, root: join(root, 'wrong-project'), relativePath: 'report.md' },
    });
    for (const caller of [
      { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo' },
      {
        source: 'mcp' as const,
        role: 'direct_task_worker' as const,
        sessionId: 'codex-desktop:worker',
      },
    ])
      expect(authorizeArtifactCaller(binding, caller)).toHaveProperty('value');
    for (const sessionId of ['worker', 'codex-desktop:other', 'claude-code:worker'])
      expect(
        authorizeArtifactCaller(binding, { source: 'mcp', role: 'direct_task_worker', sessionId })
      ).toEqual({ reason: { accepted: false, reason: 'unavailable' } });
    expect(
      authorizeArtifactCaller(binding, { source: 'mcp', role: 'neo', sessionId: 'other-neo' })
    ).toEqual({ reason: { accepted: false, reason: 'unavailable' } });
  });

  test('refuses remote, missing, unknown and subagent records without a target-folder fallback', () => {
    for (const ref of [
      { adapter: 'codex-desktop', id: 'worker', daemon: 'remote' },
      { adapter: 'codex-desktop', id: 'missing' },
      { adapter: 'unknown', id: 'worker' },
    ]) {
      sessions.recordRef('todo', ref);
      expect(load()).toBeNull();
    }
    sessions.recordRef('todo', { adapter: 'codex-desktop', id: 'worker' });
    native.exec("UPDATE threads SET source = 'subagent' WHERE id = 'worker'");
    expect(load()).toBeNull();
    native.exec("UPDATE threads SET source = 'cli', cwd = NULL WHERE id = 'worker'");
    expect(load()).toBeNull();
  });

  test('accepts nonsensitive roots and rereads cwd instead of caching it', () => {
    for (const folder of ['.codex', '.claude', '.config']) {
      const path = join(home, folder, 'worktree');
      native.prepare('UPDATE threads SET cwd = ?').run(path);
      const binding = load()!;
      expect(binding.workspacePath).toBe(path);
      expect(
        resolveArtifactSource(binding, 'report.md', { daemonId: 'daemon', home, loadBinding: load })
      ).toEqual({ value: { context, root: path, relativePath: 'report.md' } });
    }
    native.prepare('UPDATE threads SET cwd = ?').run(workspace);
    expect(load()?.workspacePath).toBe(workspace);
  });

  test('Neo ask context uses only its own session workspace', () => {
    const binding = loadRegistrationBinding(db, 'daemon', { kind: 'ask', id: 'ask' }, home)!;
    expect(binding).toMatchObject({
      neoSessionId: 'neo',
      workerSessionId: null,
      workspacePath: join(root, 'neo-workspace'),
    });
    expect(
      authorizeArtifactCaller(binding, { source: 'mcp', role: 'neo', sessionId: 'neo' })
    ).toHaveProperty('value');
    expect(
      authorizeArtifactCaller(binding, { source: 'mcp', role: 'neo', sessionId: 'other' })
    ).toHaveProperty('reason');
  });
});
