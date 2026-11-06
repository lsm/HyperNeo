import { findExecutable } from '../../../../src/lib/drivers/find-executable';
import { gitWorktreeProject } from '../../../../src/lib/drivers/worktree-project';
import { testDirectories } from '../../../helpers/temporary-directory';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  COPILOT_CLIENT,
  type CopilotDiscoveryDeps,
  type CopilotSession,
  copilotSessionTitle,
  copilotSessionFolder,
  createCopilotDiscovery,
  planCopilotSessionWindow,
  reuseCopilotSessionList,
} from '../../../../src/lib/drivers/copilot-discovery';

const createTestDirectory = testDirectories();

const NOW = 10_000_000;
const session = (
  sessionId: string,
  cwd: string,
  title: string,
  updatedAt = NOW - 3_600_000
): CopilotSession => ({ sessionId, cwd, title, updatedAt });

function adapter(sessions: CopilotSession[], own: string[] = [], deps = {}) {
  const base: CopilotDiscoveryDeps = {
    machine: 'laptop',
    now: () => NOW,
    listSessions: async () => sessions,
    ownSessions: () => new Set(own),
    projectFolder: (folder) => folder.replace(/\/\.wt\/[^/]+$/, ''),
    ...deps,
  };
  return createCopilotDiscovery(base);
}

describe('createCopilotDiscovery.find', () => {
  test('keeps only the Copilot discovery registration', () => {
    expect(adapter([]).id).toBe('copilot-cli');
  });

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

  test('links each session into the GitHub Copilot app when it is installed', async () => {
    const copilot = COPILOT_CLIENT;
    const listed = [session('s/1', '/repo', 'Work')];
    const [linked] = await adapter(listed, [], { link: copilot.app?.link }).find({
      includeClosed: false,
      limit: 20,
    });
    expect(linked.work[0].link).toBe('ghapp://sessions/s%2F1');
    const [group] = await adapter(listed).find({ includeClosed: false, limit: 20 });
    expect(group.work[0].link).toBeUndefined();
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

describe('Copilot discovery helpers', () => {
  test('copilotSessionTitle drops the role prefix, flattens whitespace and bounds length', () => {
    expect(copilotSessionTitle('[User]:  fix\n the   build')).toBe('fix the build');
    expect(copilotSessionTitle(null)).toBe('Untitled session');
    expect(copilotSessionTitle('x'.repeat(200))).toHaveLength(80);
  });

  test('findExecutable resolves the first PATH entry holding the binary', () => {
    const dir = createTestDirectory(join(tmpdir(), 'copilot-bin-'));
    writeFileSync(join(dir, 'copilot'), '');
    expect(findExecutable('copilot', `/nowhere:${dir}`)).toBe(join(dir, 'copilot'));
    expect(findExecutable('copilot', '/nowhere')).toBeNull();
  });

  test('gitWorktreeProject maps a linked worktree to its main repository', async () => {
    const root = createTestDirectory(join(tmpdir(), 'copilot-wt-'));
    const worktree = join(root, 'wt');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${root}/repo/.git/worktrees/wt\n`);
    expect(await gitWorktreeProject(worktree)).toBe(`${root}/repo`);
    expect(await gitWorktreeProject(root)).toBe(root);
  });

  test('copilotSessionFolder reads the starting folder from the session log', async () => {
    const state = createTestDirectory(join(tmpdir(), 'copilot-state-'));
    mkdirSync(join(state, 's1'));
    writeFileSync(
      join(state, 's1', 'events.jsonl'),
      `${JSON.stringify({ type: 'session.start', data: { context: { cwd: '/repo' } } })}\n{}\n`
    );
    expect(await copilotSessionFolder('s1', state)).toBe('/repo');
    expect(await copilotSessionFolder('missing', state)).toBeNull();
    expect(await copilotSessionFolder('../s1', state)).toBeNull();
  });

  test('reuseCopilotSessionList reuses one listing, failed or not, for a minute', async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const list = reuseCopilotSessionList(
      async () => {
        calls++;
        if (fail) throw new Error('agent down');
        return [session('s1', '/repo', 'Work')];
      },
      () => now
    );
    await expect(list()).rejects.toThrow('agent down');
    await expect(list()).rejects.toThrow('agent down');
    expect(calls).toBe(1);
    fail = false;
    now = 60_000;
    expect(await list()).toHaveLength(1);
    await list();
    expect(calls).toBe(2);
  });

  test('keeps the complete 50-row boundary before stopping at the 90-day horizon', () => {
    const day = 86_400_000;
    const metadata = Array.from({ length: 150 }, (_, index) => ({
      sessionId: String(index),
      startTime: new Date(0),
      modifiedTime: new Date((index < 49 ? 200 - index : 100 - (index - 49)) * day),
      isRemote: false,
    }));
    expect(planCopilotSessionWindow(metadata, 110 * day).map((item) => item.sessionId)).toEqual(
      metadata.slice(0, 50).map((item) => item.sessionId)
    );
  });

  test('retains the existing 500-session maximum and newest-first ordering', () => {
    const metadata = Array.from({ length: 600 }, (_, index) => ({
      sessionId: String(index),
      startTime: new Date(0),
      modifiedTime: new Date(1_800_000_000_000 - index),
      isRemote: false,
    }));
    expect(
      planCopilotSessionWindow([...metadata].reverse(), 0).map((item) => item.sessionId)
    ).toEqual(metadata.slice(0, 500).map((item) => item.sessionId));
  });

  test('reuseCopilotSessionList answers from the last listing while a fresh one loads', async () => {
    let now = 0;
    let round = 0;
    let release: () => void = () => {};
    const list = reuseCopilotSessionList(
      async () => {
        round++;
        if (round === 3) throw new Error('agent down');
        if (round === 2) await new Promise<void>((resolve) => (release = resolve));
        return [session(`s${round}`, '/repo', 'Work')];
      },
      () => now
    );

    expect((await list()).map((s) => s.sessionId)).toEqual(['s1']);
    now = 60_000;
    expect((await list()).map((s) => s.sessionId)).toEqual(['s1']);
    expect(round).toBe(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await list()).map((s) => s.sessionId)).toEqual(['s2']);
    now = 120_000;
    expect((await list()).map((s) => s.sessionId)).toEqual(['s2']);
    expect(round).toBe(3);
  });
});
