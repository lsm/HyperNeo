import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let root: string;
let home: string;
let repo: string;
let worktree: string;
let sessions: NeoTodoSessionRepository;
const context = { kind: 'todo' as const, id: 'todo' };
const load = () => loadRegistrationBinding(db, 'daemon', context, home);
const deps = () => ({ daemonId: 'daemon', home, loadBinding: load });
const desktopRecord = (record: Record<string, unknown>) =>
  writeFileSync(
    join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/scope/local_w.json'),
    JSON.stringify({ sessionId: 'local_w', ...record })
  );
const transcript = (cwd: string) =>
  writeFileSync(
    join(home, '.claude/projects/-repo/cli-w.jsonl'),
    `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd })}\n`
  );

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-artifact-binding-')));
  home = join(root, 'home');
  repo = join(root, 'repo');
  worktree = join(repo, '.claude', 'worktrees', 'w');
  mkdirSync(join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/scope'), {
    recursive: true,
  });
  mkdirSync(join(home, '.claude/projects/-repo'), { recursive: true });
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
  sessions = new NeoTodoSessionRepository(db);
  sessions.create('todo', {
    verb: 'start',
    adapter: 'claude-desktop',
    place: { machine: 'local', name: 'Grouped project', folder: repo },
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('loadRegistrationBinding for Claude workers', () => {
  test('binds a Claude Desktop worker to its own worktree, not the grouped repo', () => {
    desktopRecord({ cwd: worktree, originCwd: repo });
    sessions.recordRef('todo', { adapter: 'claude-desktop', id: 'local_w' });
    const binding = load()!;
    expect(binding).toMatchObject({
      workspacePath: worktree,
      workerSessionId: 'claude-desktop:local_w',
      workerRef: { adapter: 'claude-desktop', id: 'local_w' },
    });
    expect(resolveArtifactSource(binding, 'report.md', deps())).toEqual({
      value: { context, root: worktree, relativePath: 'report.md' },
    });
    expect(resolveArtifactSource(binding, join(repo, 'report.md'), deps())).toEqual({
      reason: { accepted: false, reason: 'outside_roots' },
    });
    expect(
      authorizeArtifactCaller(binding, { source: 'mcp', role: 'neo', sessionId: 'neo' })
    ).toHaveProperty('value');
  });

  test('binds a Claude Code worker to the cwd its transcript records', () => {
    transcript(worktree);
    sessions.recordRef('todo', { adapter: 'claude-code', id: 'cli-w' });
    const binding = load()!;
    expect(binding).toMatchObject({
      workspacePath: worktree,
      workerRef: { adapter: 'claude-code', id: 'cli-w' },
    });
    expect(resolveArtifactSource(binding, join(worktree, 'docs/report.md'), deps())).toEqual({
      value: { context, root: worktree, relativePath: 'docs/report.md' },
    });
  });

  test('refuses remote, missing, mismatched and unsafe Claude refs', () => {
    desktopRecord({ sessionId: 'local_other', cwd: worktree });
    transcript('');
    for (const ref of [
      { adapter: 'claude-desktop', id: 'local_w', daemon: 'remote' },
      { adapter: 'claude-desktop', id: 'local_w' },
      { adapter: 'claude-desktop', id: 'local_missing' },
      { adapter: 'claude-desktop', id: '../scope/local_w' },
      { adapter: 'claude-code', id: 'cli-w' },
      { adapter: 'claude-code', id: '../-repo/cli-w' },
    ]) {
      sessions.recordRef('todo', ref);
      expect(load()).toBeNull();
    }
    mkdirSync(join(home, '.claude/projects/-other/cli-dir.jsonl'), { recursive: true });
    sessions.recordRef('todo', { adapter: 'claude-code', id: 'cli-dir' });
    expect(load()).toBeNull();
  });

  test('accepts only a direct repo worktree under .claude, never home or deeper paths', () => {
    sessions.recordRef('todo', { adapter: 'claude-desktop', id: 'local_w' });
    for (const cwd of [
      join(home, '.claude', 'worktrees', 'w'),
      join(home, '.claude', 'projects'),
      join(repo, '.claude', 'worktrees'),
      join(repo, '.claude', 'worktrees', 'w', 'nested'),
      join(repo, '.claude', 'worktrees', 'w', '.codex', 'x'),
    ]) {
      desktopRecord({ cwd });
      expect(resolveArtifactSource(load()!, 'report.md', deps())).toEqual({
        reason: { accepted: false, reason: 'outside_roots' },
      });
    }
  });
});
