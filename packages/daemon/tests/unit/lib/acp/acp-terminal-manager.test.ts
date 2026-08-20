import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

const spawned: MockChildProcess[] = [];

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = mock((_signal: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

mock.module('node:child_process', () => ({
  spawn: () => {
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
  });

  test('escalates an unresponsive terminal process to SIGKILL', async () => {
    const manager = new AcpTerminalManager();
    const { terminalId } = await manager.create({ sessionId: 'session-1', command: 'sleep' });
    const child = spawned[0];

    await manager.kill(params(terminalId));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 5100));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  }, 6000);

  test('dispose terminates every active terminal process', async () => {
    const manager = new AcpTerminalManager();
    await manager.create({ sessionId: 'session-1', command: 'first' });
    await manager.create({ sessionId: 'session-1', command: 'second' });

    manager.dispose();

    expect(spawned[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawned[1].kill).toHaveBeenCalledWith('SIGTERM');
  });
});
