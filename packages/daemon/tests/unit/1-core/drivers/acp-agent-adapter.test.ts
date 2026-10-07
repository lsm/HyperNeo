import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  ACP_AGENTS,
  type AcpAgentAdapterDeps,
  type AcpAgentSession,
  acpSessionTitle,
  copilotSessionFolder,
  createAcpAgentAdapter,
  findAcpAgentBinary,
  gitWorktreeProject,
  reuseAcpSessionList,
} from '../../../../src/lib/drivers/acp-agent-adapter';

const NOW = 10_000_000;
const session = (
  sessionId: string,
  cwd: string,
  title: string,
  updatedAt = NOW - 3_600_000
): AcpAgentSession => ({ sessionId, cwd, title, updatedAt });

function adapter(sessions: AcpAgentSession[], own: string[] = [], deps = {}) {
  const base: AcpAgentAdapterDeps = {
    agent: ACP_AGENTS[0],
    machine: 'laptop',
    now: () => NOW,
    listSessions: async () => sessions,
    ownSessions: () => new Set(own),
    projectFolder: (folder) => folder.replace(/\/\.wt\/[^/]+$/, ''),
    ...deps,
  };
  return createAcpAgentAdapter(base);
}

describe('createAcpAgentAdapter.find', () => {
  test('groups agent sessions by project folder with live status and newest first', async () => {
    const groups = await adapter([
      session('old', '/repo', 'Old work'),
      session('live', '/repo/.wt/fix', 'Fixing the bug', NOW - 1_000),
      session('other', '/notes', 'Notes'),
    ]).find({ includeClosed: false, limit: 20 });
    expect(groups).toEqual([
      {
        place: { machine: 'laptop', folder: '/repo', name: 'repo' },
        lastActivityAt: NOW - 1_000,
        openCount: 2,
        archivedCount: 0,
        adapters: ['copilot-cli'],
        work: [
          {
            ref: { adapter: 'copilot-cli', id: 'live' },
            title: 'Fixing the bug',
            place: { machine: 'laptop', folder: '/repo', name: 'repo' },
            status: 'running',
            lastActivityAt: NOW - 1_000,
          },
          expect.objectContaining({ ref: { adapter: 'copilot-cli', id: 'old' }, status: 'done' }),
        ],
      },
      expect.objectContaining({ place: { machine: 'laptop', folder: '/notes', name: 'notes' } }),
    ]);
  });

  test('skips HyperNeo-owned and temp sessions, and filters by text, folder and Space', async () => {
    const find = adapter(
      [
        session('mine', '/repo', 'Heron plan'),
        session('tmp', join(tmpdir(), 'scratch'), 'Heron scratch'),
        session('match', '/repo', 'Heron rollout'),
        session('miss', '/repo', 'Unrelated'),
        session('elsewhere', '/notes', 'Heron notes'),
      ],
      ['mine']
    ).find;
    const byText = await find({ text: 'heron', folder: '/repo', includeClosed: false, limit: 20 });
    expect(byText.flatMap((group) => group.work.map((work) => work.ref.id))).toEqual(['match']);
    expect(await find({ spaceId: 'space-1', includeClosed: false, limit: 20 })).toEqual([]);
  });
});

describe('ACP agent helpers', () => {
  test('acpSessionTitle drops the role prefix, flattens whitespace and bounds length', () => {
    expect(acpSessionTitle('[User]:  fix\n the   build')).toBe('fix the build');
    expect(acpSessionTitle(null)).toBe('Untitled session');
    expect(acpSessionTitle('x'.repeat(200))).toHaveLength(80);
  });

  test('findAcpAgentBinary resolves the first PATH entry holding the binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-bin-'));
    writeFileSync(join(dir, 'copilot'), '');
    expect(findAcpAgentBinary('copilot', `/nowhere:${dir}`)).toBe(join(dir, 'copilot'));
    expect(findAcpAgentBinary('copilot', '/nowhere')).toBeNull();
  });

  test('gitWorktreeProject maps a linked worktree to its main repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-wt-'));
    const worktree = join(root, 'wt');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${root}/repo/.git/worktrees/wt\n`);
    expect(gitWorktreeProject(worktree)).toBe(`${root}/repo`);
    expect(gitWorktreeProject(root)).toBe(root);
  });

  test('copilotSessionFolder reads the starting folder from the session log', async () => {
    const state = mkdtempSync(join(tmpdir(), 'copilot-state-'));
    mkdirSync(join(state, 's1'));
    writeFileSync(
      join(state, 's1', 'events.jsonl'),
      `${JSON.stringify({ type: 'session.start', data: { context: { cwd: '/repo' } } })}\n{}\n`
    );
    expect(await copilotSessionFolder('s1', state)).toBe('/repo');
    expect(await copilotSessionFolder('missing', state)).toBeNull();
    expect(await copilotSessionFolder('../s1', state)).toBeNull();
  });

  test('reuseAcpSessionList reuses one listing for a minute and retries after a failure', async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const list = reuseAcpSessionList(
      async () => {
        calls++;
        if (fail) throw new Error('agent down');
        return [session('s1', '/repo', 'Work')];
      },
      () => now
    );
    await expect(list()).rejects.toThrow('agent down');
    fail = false;
    await list();
    await list();
    expect(calls).toBe(2);
    now = 60_000;
    await list();
    expect(calls).toBe(3);
  });
});
