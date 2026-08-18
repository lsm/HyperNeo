import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('File RPC Handlers', () => {
  let daemon: DaemonServerContext;
  let testDir: string;

  beforeEach(async () => {
    daemon = await createDaemonServer();
    testDir = `/tmp/file-rpc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(`${testDir}/subdir`, { recursive: true });
    writeFileSync(`${testDir}/test.txt`, 'Hello File');
    writeFileSync(`${testDir}/subdir/nested.txt`, 'Nested');
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }, 15_000);

  async function createSession(): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: testDir,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  describe('file.read', () => {
    test('should read file with utf-8 encoding', async () => {
      const sessionId = await createSession();

      const result = (await daemon.messageHub.request('file.read', {
        sessionId,
        path: 'test.txt',
        encoding: 'utf-8',
      })) as { content: string; encoding: string };

      expect(result.content).toBe('Hello File');
      expect(result.encoding).toBe('utf-8');
    });

    test('should read file with base64 encoding', async () => {
      const sessionId = await createSession();

      const result = (await daemon.messageHub.request('file.read', {
        sessionId,
        path: 'test.txt',
        encoding: 'base64',
      })) as { content: string; encoding: string };

      expect(result.encoding).toBe('base64');
      expect(result.content).toBeString();
    });

    test('should throw for invalid session', async () => {
      await expect(
        daemon.messageHub.request('file.read', {
          sessionId: 'invalid',
          path: 'test.txt',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('file.list', () => {
    test('should list files in directory', async () => {
      const sessionId = await createSession();

      const result = (await daemon.messageHub.request('file.list', {
        sessionId,
        path: '.',
      })) as { files: Array<Record<string, unknown>> };

      expect(result.files).toBeDefined();
      expect(Array.isArray(result.files)).toBe(true);
    });

    test('should list files recursively', async () => {
      const sessionId = await createSession();

      const result = (await daemon.messageHub.request('file.list', {
        sessionId,
        path: '.',
        recursive: true,
      })) as { files: Array<Record<string, unknown>> };

      expect(result.files).toBeDefined();
    });

    test('should throw for invalid session', async () => {
      await expect(
        daemon.messageHub.request('file.list', {
          sessionId: 'invalid',
          path: '.',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('file.tree', () => {
    test('should get file tree', async () => {
      const sessionId = await createSession();

      const result = (await daemon.messageHub.request('file.tree', {
        sessionId,
        path: '.',
      })) as { tree: Record<string, unknown> };

      expect(result.tree).toBeDefined();
      expect(result.tree.type).toBe('directory');
    });

    test('should support maxDepth', async () => {
      const sessionId = await createSession();

      const result = (await daemon.messageHub.request('file.tree', {
        sessionId,
        path: '.',
        maxDepth: 2,
      })) as { tree: Record<string, unknown> };

      expect(result.tree).toBeDefined();
    });

    test('should throw for invalid session', async () => {
      await expect(
        daemon.messageHub.request('file.tree', {
          sessionId: 'invalid',
        })
      ).rejects.toThrow('Session not found');
    });
  });
});
