import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';
import { gitWorktreeProject } from '../../../../src/lib/drivers/acp-agent-adapter.ts';
import { EventLoopActivity } from '../../../../src/lib/event-loop-activity.ts';
import { findLocally } from '../../../../src/lib/drivers/find-operation.ts';
import { delayedWorktree, syntheticCodex } from '../../../helpers/worktree-delay.ts';

vi.mock('node:fs/promises', { spy: true });

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('Codex discovery with delayed worktree storage', () => {
  test('keeps the event loop responsive while resolving the actual .git pointer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-delay-'));
    const fixture = delayedWorktree(root);
    const activity = new EventLoopActivity();
    const stop = activity.activate();
    const adapter = syntheticCodex(root, fixture.folder, fixture.project);
    let previous = performance.now(),
      maxLagMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxLagMs = Math.max(maxLagMs, now - previous - 10);
      previous = now;
    }, 10);
    try {
      await fixture.ready;
      await wait(30);
      const groups = await adapter.find({ includeClosed: false, limit: 20 });
      await wait(20);
      expect(await fixture.closed).toBe(0);
      expect(groups).toHaveLength(1);
      expect(groups[0].place.folder).toBe(fixture.project);
      expect(groups[0].work[0].ref.id).toBe('thread');
      expect(groups[0].work[0].place.folder).toBe(fixture.folder);
      expect(maxLagMs).toBeLessThan(250);
      const names = activity.drain().entries.map((entry) => entry.name);
      for (const phase of [
        'open',
        'configure',
        'roots',
        'folders',
        'threads',
        'query',
        'close',
        'worktrees',
        'groups',
      ])
        expect(names).toContain(`scanner:codex_desktop:${phase}`);
      expect(names).toContain('scanner:worktree:read');
    } finally {
      stop();
      clearInterval(timer);
      fixture.writer.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});

describe('worktree project cache', () => {
  test('reuses unchanged pointers per path and observes edits, replacement and recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-cache-'));
    const folder = join(root, 'wt');
    mkdirSync(folder);
    const file = join(folder, '.git');
    const reads = () => vi.mocked(readFile).mock.calls.filter(([path]) => path === file).length;
    try {
      writeFileSync(file, 'gitdir: /one/.git/worktrees/wt\n');
      expect(await Promise.all([gitWorktreeProject(folder), gitWorktreeProject(folder)])).toEqual([
        '/one',
        '/one',
      ]);
      expect(reads()).toBe(1);
      expect(await gitWorktreeProject(folder)).toBe('/one');
      expect(reads()).toBe(1);
      writeFileSync(file, 'gitdir: /changed/.git/worktrees/wt\n');
      expect(await gitWorktreeProject(folder)).toBe('/changed');
      expect(reads()).toBe(2);
      unlinkSync(file);
      expect(await gitWorktreeProject(folder)).toBe(folder);
      mkdirSync(file);
      expect(await gitWorktreeProject(folder)).toBe(folder);
      expect(await gitWorktreeProject(folder)).toBe(folder);
      expect(reads()).toBe(2);
      rmSync(file, { recursive: true });
      writeFileSync(file, 'gitdir: /restored/.git/worktrees/wt\n');
      expect(await gitWorktreeProject(folder)).toBe('/restored');
      expect(reads()).toBe(3);
      const other = join(root, 'other');
      mkdirSync(other);
      writeFileSync(join(other, '.git'), 'not a worktree');
      expect(await gitWorktreeProject(other)).toBe(other);
      expect(await gitWorktreeProject(folder)).toBe('/restored');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('per-adapter discovery phases', () => {
  test('records each async completion or rejection with its adapter identity', async () => {
    const activity = new EventLoopActivity();
    const stop = activity.activate();
    try {
      const outcome = await findLocally(
        [
          { id: 'first', capabilities: ['find'], find: async () => [] },
          {
            id: 'second',
            capabilities: ['find'],
            find: async () => {
              throw new Error('unavailable');
            },
          },
        ],
        { includeClosed: false, limit: 20 }
      );
      expect(outcome.groups).toEqual([]);
      expect(outcome.unreachable).toEqual([{ source: 'second', reason: 'unavailable' }]);
      expect(activity.drain().entries.map(({ name, kind }) => [name, kind])).toEqual([
        ['work:find:first', 'start'],
        ['work:find:second', 'start'],
        ['work:find:first', 'end'],
        ['work:find:second', 'end'],
      ]);
    } finally {
      stop();
    }
  });
});
