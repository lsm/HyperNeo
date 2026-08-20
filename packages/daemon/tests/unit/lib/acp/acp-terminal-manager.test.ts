import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const spawned: MockChildProcess[] = [];
const spawnCalls: Array<{
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean };
}> = [];
let nextPid = 100;

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = nextPid++;
  kill = mock((_signal: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

mock.module('node:child_process', () => ({
  spawn: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; detached?: boolean }
  ) => {
    spawnCalls.push({ command, args, options });
    const child = new MockChildProcess();
    spawned.push(child);
    return child;
  },
}));

const { AcpTerminalManager } = await import('../../../../src/lib/acp/acp-terminal-manager');

function params(terminalId: string) {
  return { sessionId: 'session-1', terminalId };
}

describe('AcpTerminalManager', () => {
  afterEach(() => {
    spawned.length = 0;
    spawnCalls.length = 0;
  });

  test('uses argv directly with the sanitized session environment and workspace', async () => {
    const manager = new AcpTerminalManager(
      { PATH: '/safe/bin', SAFE_TOKEN: 'session' },
      '/workspace'
    );

    await manager.create({
      sessionId: 'session-1',
      command: 'devin tool; ignored',
      args: ['literal arg'],
    });

    expect(spawnCalls[0]).toEqual({
      command: 'devin tool; ignored',
      args: ['literal arg'],
      options: {
        cwd: '/workspace',
        env: { PATH: '/safe/bin', SAFE_TOKEN: 'session' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    });
  });

  test('parses command strings into argv without invoking a shell', async () => {
    const manager = new AcpTerminalManager();

    await manager.create({ sessionId: 'session-1', command: 'npm test -- --runInBand' });

    expect(spawnCalls[0]).toMatchObject({
      command: 'npm',
      args: ['test', '--', '--runInBand'],
    });
  });

  test('returns the newest output bytes when truncating', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 4,
    });

    spawned[0].stdout.emit('data', Buffer.from('abcdefghij'));

    expect(await manager.output(params(terminalId))).toMatchObject({
      output: 'ghij',
      truncated: true,
    });
  });

  test('does not report truncation when output exactly fills the limit', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 4,
    });

    spawned[0].stdout.emit('data', Buffer.from('abcd'));

    expect(await manager.output(params(terminalId))).toMatchObject({
      output: 'abcd',
      truncated: false,
    });
  });

  test('reports close status to output and pending waiters', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'command' });
    const waiting = manager.waitForExit(params(terminalId));

    spawned[0].emit('close', 7, null);

    await expect(waiting).resolves.toEqual({ exitCode: 7, signal: null });
    expect(await manager.output(params(terminalId))).toMatchObject({
      exitStatus: { exitCode: 7, signal: null },
    });
  });

  test('observes spawn errors when process-tree ownership fails', async () => {
    const manager = new AcpTerminalManager({}, undefined, (child) => {
      expect(child.listenerCount('error')).toBeGreaterThan(0);
      throw new Error('missing process id');
    });

    await expect(manager.create({ sessionId: 'session-1', command: 'missing' })).rejects.toThrow(
      'missing process id'
    );
    expect(() => spawned[0].emit('error', new Error('not found'))).not.toThrow();
  });

  test('keeps spawn errors when a later close event arrives', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'missing' });
    const waiting = manager.waitForExit(params(terminalId));

    spawned[0].emit('error', new Error('not found'));
    spawned[0].emit('close', null, null);

    await expect(waiting).resolves.toEqual({ exitCode: 1, signal: null });
    expect(await manager.output(params(terminalId))).toMatchObject({
      output: 'Process error: not found\n',
      exitStatus: { exitCode: 1, signal: null },
    });
  });

  test('release kills a running terminal and removes it', async () => {
    const terminate = mock((_signal: NodeJS.Signals) => {});
    const processTreeOwner = mock(() => ({ terminate }));
    const manager = new AcpTerminalManager({}, undefined, processTreeOwner);
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'command' });

    await manager.release(params(terminalId));

    expect(processTreeOwner).toHaveBeenCalledWith(spawned[0]);
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
    await expect(manager.output(params(terminalId))).rejects.toThrow(
      `Unknown or released ACP terminal: ${terminalId}`
    );
  });

  test('release terminates the retained process tree after its leader exits', async () => {
    const terminate = mock((_signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, () => ({ terminate }));
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'command' });

    spawned[0].emit('close', 0, null);
    await manager.release(params(terminalId));

    expect(terminate).toHaveBeenCalledWith('SIGTERM');
  });

  test('dispose terminates the retained process tree after its leader exits', async () => {
    const terminate = mock((_signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, () => ({ terminate }));
    await manager.create({ sessionId: 'session-1', command: 'command' });

    spawned[0].emit('close', 0, null);
    manager.dispose();

    expect(terminate).toHaveBeenCalledWith('SIGTERM');
  });

  test('rejects operations for unknown terminal ids', async () => {
    const manager = new AcpTerminalManager();
    const unknown = params('unknown');

    await expect(manager.output(unknown)).rejects.toThrow('Unknown or released ACP terminal');
    await expect(manager.waitForExit(unknown)).rejects.toThrow('Unknown or released ACP terminal');
    await expect(manager.kill(unknown)).rejects.toThrow('Unknown or released ACP terminal');
    await expect(manager.release(unknown)).rejects.toThrow('Unknown or released ACP terminal');
  });

  test('rejects terminal creation after disposal', async () => {
    const manager = new AcpTerminalManager();
    manager.dispose();

    await expect(manager.create({ sessionId: 'session-1', command: 'command' })).rejects.toThrow(
      'ACP terminal manager has been disposed'
    );
    expect(spawnCalls).toHaveLength(0);
  });

  test('clamps output limits', async () => {
    const manager = new AcpTerminalManager();
    const low = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 0,
    });
    const high = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: Number.MAX_SAFE_INTEGER,
    });
    const malformed = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 'invalid' as unknown as number,
    });
    const fractional = await manager.create({
      sessionId: 'session-1',
      command: 'command',
      outputByteLimit: 1.5,
    });

    spawned[0].stdout.emit('data', Buffer.from('abc'));
    spawned[1].stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
    spawned[2].stdout.emit('data', Buffer.alloc(1024 * 1024 + 1, 'x'));
    spawned[3].stdout.emit('data', Buffer.from('ab'));

    expect(await manager.output(params(low.terminalId))).toMatchObject({
      output: 'c',
      truncated: true,
    });
    const highOutput = await manager.output(params(high.terminalId));
    expect(Buffer.byteLength(highOutput.output)).toBe(4 * 1024 * 1024);
    expect(highOutput.truncated).toBe(true);
    const malformedOutput = await manager.output(params(malformed.terminalId));
    expect(Buffer.byteLength(malformedOutput.output)).toBe(1024 * 1024);
    expect(malformedOutput.truncated).toBe(true);
    expect(await manager.output(params(fractional.terminalId))).toMatchObject({
      output: 'b',
      truncated: true,
    });
  });

  test('signals the terminal process tree and escalates to SIGKILL', async () => {
    const terminate = mock((_signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, () => ({ terminate }));
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'sleep' });

    await manager.kill(params(terminalId));
    expect(terminate).toHaveBeenCalledWith('SIGTERM');

    if (process.platform !== 'win32') {
      await new Promise((resolve) => setTimeout(resolve, 5100));
      expect(terminate).toHaveBeenCalledWith('SIGKILL');
    }
  }, 6000);

  test('dispose terminates every active terminal process tree', async () => {
    const terminate = mock((_signal: NodeJS.Signals) => {});
    const manager = new AcpTerminalManager({}, undefined, () => ({ terminate }));
    await manager.create({ sessionId: 'session-1', command: 'first' });
    await manager.create({ sessionId: 'session-1', command: 'second' });

    manager.dispose();

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(terminate).toHaveBeenNthCalledWith(2, 'SIGTERM');
  });
});
