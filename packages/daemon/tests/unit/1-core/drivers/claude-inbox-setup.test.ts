import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openClaudeInbox } from '../../../../src/lib/drivers/claude-inbox';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, chmod: vi.fn(fs.chmod) };
});

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('openClaudeInbox chmod-failure cleanup', () => {
  test.each([false, true])(
    'preserves only a replacement socket (replaced: %s)',
    async (replace) => {
      const dir = await mkdtemp('/tmp/hn-inbox-setup-');
      const targetPath = join(dir, '456.sock');
      const peer = createServer();
      let replacement: Server | undefined;
      let replyPath = '';
      let replacementInode: number | undefined;
      const denied = Object.assign(new Error('chmod denied'), { code: 'EACCES' });
      try {
        await listen(peer, targetPath);
        await chmod(targetPath, 0o600);
        vi.mocked(chmod).mockImplementationOnce(async (path) => {
          replyPath = String(path);
          expect((await lstat(replyPath)).isSocket()).toBe(true);
          if (replace) {
            await rename(replyPath, join(dir, 'saved.sock'));
            replacement = createServer();
            await listen(replacement, replyPath);
            replacementInode = (await lstat(replyPath)).ino;
          }
          throw denied;
        });
        await expect(openClaudeInbox(dir, 'abc123', () => {})).rejects.toBe(denied);
        expect(replyPath).not.toBe('');
        expect(replyPath).not.toBe(targetPath);
        if (replace) {
          expect((await lstat(replyPath)).ino).toBe(replacementInode);
          expect(replacement?.listening).toBe(true);
        } else await expect(lstat(replyPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(peer.listening).toBe(true);
        expect((await lstat(targetPath)).isSocket()).toBe(true);
        expect((await readdir(dir)).filter((name) => name.startsWith('.hn-'))).toEqual([]);
      } finally {
        vi.mocked(chmod).mockReset();
        if (replacement) await close(replacement);
        await close(peer);
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  test('normal close preserves a replacement at the published reply path', async () => {
    const dir = await mkdtemp('/tmp/hn-inbox-close-');
    const peer = createServer();
    const replacement = createServer();
    let inbox: Awaited<ReturnType<typeof openClaudeInbox>> | undefined;
    try {
      const path = join(dir, '456.sock');
      await listen(peer, path);
      await chmod(path, 0o600);
      inbox = await openClaudeInbox(dir, 'abc123', () => {});
      await rename(inbox.path, join(dir, 'saved.sock'));
      await listen(replacement, inbox.path);
      const inode = (await lstat(inbox.path)).ino;
      await inbox.close();
      expect((await lstat(inbox.path)).ino).toBe(inode);
      expect(replacement.listening).toBe(true);
      expect((await readdir(dir)).filter((name) => name.startsWith('.hn-'))).toEqual([]);
    } finally {
      await inbox?.close();
      await close(replacement);
      await close(peer);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
