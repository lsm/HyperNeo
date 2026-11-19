import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  createCopilotDesktopAdapter,
  type CopilotDesktopSession,
} from '../../../../src/lib/drivers/copilot-desktop-adapter.ts';

const session: CopilotDesktopSession = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  title: 'Desktop work',
  project: 'Example',
  folder: '/projects/example',
  directory: '/worktrees/example',
  updatedAt: '2026-11-19T12:00:00.000Z',
  running: 1,
  interrupted: 0,
  archived: 0,
};
const query = { includeClosed: false, limit: 20 };

describe('createCopilotDesktopAdapter', () => {
  test('discovers Desktop work with its own identity and workspace link', async () => {
    const adapter = createCopilotDesktopAdapter(async () => [session], 'host', '/home');
    const groups = await adapter.find(query);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      place: { name: 'Example', folder: '/projects/example' },
      openCount: 1,
      work: [
        {
          ref: { id: 'session-1', adapter: 'copilot-cli' },
          execution: { directory: '/worktrees/example', machine: 'host' },
          link: 'ghapp://sessions/workspace-1',
          status: 'running',
        },
      ],
    });
  });

  test('passes an exact session ID for status and reports persisted interruption', async () => {
    const read = vi.fn(async () => [{ ...session, running: 0, interrupted: 1 }]);
    const adapter = createCopilotDesktopAdapter(read, 'host', '/home');
    const ref = { adapter: 'copilot-cli', id: 'session-1' };
    await expect(adapter.status?.(ref)).resolves.toMatchObject({
      ok: true,
      value: { ref, status: 'stopped' },
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ includeClosed: true, limit: 1 }, ref.id);
  });

  test('skips the Desktop database for a Space-scoped search', async () => {
    const read = vi.fn(async () => [session]);
    const adapter = createCopilotDesktopAdapter(read, 'host', '/home');
    expect(await adapter.find({ ...query, spaceId: 'unrelated' })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  test('pages history only for sessions recorded by Desktop', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-desktop-history-'));
    try {
      const directory = join(home, '.copilot', 'session-state', session.id);
      mkdirSync(directory, { recursive: true });
      const log = [
        { type: 'user.message', data: { messageId: 'one', content: 'MARKER\nInput' } },
        { type: 'assistant.message', data: { messageId: 'two', content: 'Reply' } },
      ].map((event) => JSON.stringify({ ...event, timestamp: session.updatedAt }));
      writeFileSync(join(directory, 'events.jsonl'), log.join('\n') + '\n');
      const adapter = createCopilotDesktopAdapter(
        async (_query, id) => (id === session.id ? [session] : []),
        'host',
        home
      );
      const latest = await adapter.readTurns?.(session.id, undefined, 0, 0);
      expect(latest?.turns).toMatchObject([{ role: 'assistant', text: 'Reply' }]);
      expect(latest?.nextCursor).toBeDefined();
      const older = await adapter.readTurns?.(session.id, undefined, 0, 0, latest?.nextCursor);
      expect(older?.turns).toMatchObject([{ role: 'user', text: 'MARKER\nInput' }]);
      await expect(adapter.readInput?.(session.id, 'MARKER')).resolves.toMatchObject({
        messageId: 'user:one',
      });
      await expect(adapter.readTurns?.('unowned', undefined, 0, 0)).resolves.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
