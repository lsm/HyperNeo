import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { planSessionCommand, resolveSender, runSessionCommand } from '../src/session-cli';

describe('hyperneo send, question and build', () => {
  test('send --kind submits a structured report without inspecting the text', () => {
    expect(
      planSessionCommand(['send', 'neo:root', '--kind', 'blocked', 'Ordinary words.'], 'worker')
    ).toEqual({
      value: {
        name: 'message.send',
        input: { to: 'neo:root', text: 'Ordinary words.', kind: 'blocked' },
      },
    });
    expect(
      planSessionCommand(['send', 'neo:root', '--kind', 'progress', 'Done.'], 'worker')
    ).toHaveProperty('reason');
  });
  test('a misplaced --kind flag fails instead of silently becoming report text', () => {
    expect(planSessionCommand(['send', 'neo:root', 'PR merged', '--kind', 'done'], 'worker')).toHaveProperty('reason');
  });
  test('lost-phone reset uses only its explicit local command', () => {
    expect(planSessionCommand(['devices', 'reset-human'], 'cli')).toEqual({
      value: { name: 'device.reset_human', input: {} },
    });
    expect(planSessionCommand(['devices', 'reset-human', 'extra'], 'cli')).toHaveProperty('reason');
  });
  test('the sender is the HyperNeo session first, then the Codex thread, then Claude Code', () => {
    expect(
      resolveSender({
        HYPERNEO_SESSION_ID: 's1',
        CODEX_THREAD_ID: 't1',
        CLAUDE_CODE_SESSION_ID: 'c1',
      })
    ).toBe('s1');
    expect(resolveSender({ CODEX_THREAD_ID: 't1', CLAUDE_CODE_SESSION_ID: 'c1' })).toBe(
      'codex-desktop:t1'
    );
    expect(resolveSender({ CLAUDE_CODE_SESSION_ID: 'c1' })).toBe('claude-code:c1');
  });

  test('with no sender variable it fails with a clear error and sends nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await runSessionCommand(['send', 'neo-root', 'hi'], { HYPERNEO_SESSION_DOOR: '/nowhere' })
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('hyperneo send: no sender'));
    error.mockRestore();
  });

  test('build requests only the read-only build operation', () => {
    expect(planSessionCommand(['build'], 'worker-1')).toEqual({
      value: { name: 'system.build', input: {} },
    });
    expect(planSessionCommand(['build', 'extra'], 'worker-1')).toHaveProperty('reason');
  });

  test('pair makes a code of the named kind, or reopens pairing after a lockout', () => {
    expect(planSessionCommand(['pair'], 'cli')).toEqual({
      value: { name: 'device.pair.create', input: { kind: 'human' } },
    });
    expect(planSessionCommand(['pair', '--kind', 'relay', '--name', 'Push relay'], 'cli')).toEqual({
      value: { name: 'device.pair.create', input: { kind: 'relay', name: 'Push relay' } },
    });
    expect(planSessionCommand(['pair', '--reset-lockout'], 'cli')).toEqual({
      value: { name: 'device.pair.reset_lockout', input: {} },
    });
    expect(planSessionCommand(['pair', '--kind'], 'cli')).toHaveProperty('reason');
    expect(planSessionCommand(['devices'], 'cli')).toEqual({
      value: { name: 'device.list', input: {} },
    });
    expect(planSessionCommand(['devices', 'revoke', 'device-1'], 'cli')).toEqual({
      value: { name: 'device.revoke', input: { deviceId: 'device-1' } },
    });
    expect(planSessionCommand(['devices', 'revoke'], 'cli')).toHaveProperty('reason');
  });

  test('build prints bounded failed health and exits unsuccessfully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'build-cli-'));
    const socketPath = join(dir, 'door.sock');
    const value = {
      commit: 'a'.repeat(40),
      version: 'test',
      pid: 1,
      startedAt: 1,
      uptime: 2,
      health: 'fail',
    };
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end(JSON.stringify({ kind: 'completed', value })));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await runSessionCommand(['build'], {
          HYPERNEO_SESSION_ID: 'worker',
          HYPERNEO_SESSION_DOOR: socketPath,
        })
      ).toBe(1);
      expect(output).toHaveBeenCalledWith(JSON.stringify(value, null, 2));
    } finally {
      output.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('send joins the words into one message and question reads by id', () => {
    expect(planSessionCommand(['send', 'neo-root', 'Tests', 'pass.'], 's1')).toEqual({
      value: {
        name: 'message.send',
        input: {
          to: 'neo-root',
          text: 'Tests pass.',
        },
      },
    });
    expect(planSessionCommand(['question', 'q-7'], 's1')).toEqual({
      value: { name: 'neo.question.get', input: { questionId: 'q-7' } },
    });
    expect(planSessionCommand(['send', 'neo-root'], 's1')).toHaveProperty('reason');
  });
});
