import { describe, expect, it, beforeEach, mock, afterEach, type Mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupDialogHandlers } from '../../../../src/lib/rpc-handlers/dialog-handlers';
import type { SpawnFn, SpawnProcess } from '../../../../src/lib/runtime-spawn';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockProcess(stdout: string, exitCode: number = 0): SpawnProcess {
  const encoder = new TextEncoder();
  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdout) controller.enqueue(encoder.encode(stdout));
      controller.close();
    },
  });
  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  return {
    pid: 4321,
    stdout: stdoutStream,
    stderr: stderrStream,
    exited: Promise.resolve(exitCode),
    exitCode,
    kill: () => {},
  };
}

function createHangingMockProcess(): { proc: SpawnProcess; kill: Mock<() => void> } {
  let resolveExit: (exitCode: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const createOpenStream = () =>
    new ReadableStream<Uint8Array>({
      start() {},
    });
  const kill = mock(() => resolveExit(143));

  const proc: SpawnProcess = {
    pid: 4321,
    stdout: createOpenStream(),
    stderr: createOpenStream(),
    exited,
    exitCode: null,
    kill,
  };

  return { proc, kill };
}

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(() => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;

  return { hub, handlers };
}

describe('Dialog RPC Handlers', () => {
  let messageHubData: ReturnType<typeof createMockMessageHub>;
  let originalPlatform: string;
  let spawnMock: Mock<SpawnFn>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    originalPlatform = process.platform;

    spawnMock = mock<SpawnFn>(() => createMockProcess(''));

    setupDialogHandlers(messageHubData.hub, spawnMock);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
    mock.restore();
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      configurable: true,
    });
  }

  describe('dialog.pickFolder', () => {
    it('registers the handler', () => {
      const handler = messageHubData.handlers.get('dialog.pickFolder');
      expect(handler).toBeDefined();
    });

    it('handler is an async function returning a Promise with a path field', async () => {
      setPlatform('darwin');
      spawnMock.mockImplementation(() => createMockProcess('/Users/test/project\n'));
      const handler = messageHubData.handlers.get('dialog.pickFolder');
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
      const result = handler!({}, {});
      expect(result).toBeInstanceOf(Promise);
      const resolved = await result;
      expect(resolved).toEqual({ path: '/Users/test/project' });
    });

    it('returns null when the spawn implementation throws an error (error-handling path)', async () => {
      setPlatform('darwin');
      spawnMock.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const handler = messageHubData.handlers.get('dialog.pickFolder')!;
      const result = await handler({}, {});

      expect(result).toEqual({ path: null });
    });

    describe('macOS (darwin)', () => {
      it('calls osascript with choose folder and returns trimmed path', async () => {
        setPlatform('darwin');
        spawnMock.mockImplementation(() => createMockProcess('/Users/test/workspace\n'));

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: '/Users/test/workspace' });
        expect(spawnMock).toHaveBeenCalledWith(
          ['osascript', '-e', expect.stringContaining('choose folder')],
          expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
        );
      });

      it('returns null when user cancels (osascript exits with non-zero code)', async () => {
        setPlatform('darwin');
        spawnMock.mockImplementation(() => createMockProcess('', 1));

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });

      it('closes the folder picker process when the daemon-side timeout expires', async () => {
        setPlatform('darwin');
        const { proc, kill } = createHangingMockProcess();
        spawnMock.mockImplementation(() => proc);

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({ timeoutMs: 1 }, {});

        expect(result).toEqual({ path: null });
        expect(kill).toHaveBeenCalledTimes(1);
      });
    });

    describe('Linux', () => {
      it('uses zenity when available and returns trimmed path', async () => {
        setPlatform('linux');
        spawnMock.mockImplementation((args: string[]) =>
          createMockProcess(args[0] === 'which' ? '/usr/bin/zenity\n' : '/home/user/workspace\n')
        );

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: '/home/user/workspace' });
        const zenityCall = spawnMock.mock.calls.find(([args]) => args[0] === 'zenity');
        expect(zenityCall).toBeDefined();
        expect(zenityCall![0]).toContain('--directory');
      });

      it('falls back to kdialog when zenity is not available', async () => {
        setPlatform('linux');
        spawnMock.mockImplementation((args: string[]) => {
          if (args[0] === 'which' && args[1] === 'zenity') {
            return createMockProcess('', 1);
          }
          if (args[0] === 'which' && args[1] === 'kdialog') {
            return createMockProcess('/usr/bin/kdialog\n');
          }
          return createMockProcess('/home/user/workspace\n');
        });

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: '/home/user/workspace' });
        const kdialogCall = spawnMock.mock.calls.find(([args]) => args[0] === 'kdialog');
        expect(kdialogCall).toBeDefined();
      });

      it('returns null when neither zenity nor kdialog is available', async () => {
        setPlatform('linux');
        spawnMock.mockImplementation(() => createMockProcess('', 1));

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });

      it('returns null when user cancels zenity', async () => {
        setPlatform('linux');
        spawnMock.mockImplementation((args: string[]) => {
          if (args[0] === 'which') {
            return createMockProcess('/usr/bin/zenity\n');
          }
          return createMockProcess('', 1);
        });

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });
    });

    describe('Windows (win32)', () => {
      it('calls powershell with FolderBrowserDialog and returns trimmed path', async () => {
        setPlatform('win32');
        spawnMock.mockImplementation(() => createMockProcess('C:\\Users\\test\\workspace\r\n'));

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: 'C:\\Users\\test\\workspace' });
        expect(spawnMock).toHaveBeenCalledWith(
          ['powershell', '-Command', expect.stringContaining('FolderBrowserDialog')],
          expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
        );
      });

      it('returns null when user cancels on Windows', async () => {
        setPlatform('win32');
        spawnMock.mockImplementation(() => createMockProcess('', 0));

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });
    });

    describe('unsupported platform', () => {
      it('returns null without spawning any process', async () => {
        setPlatform('freebsd');

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
        expect(spawnMock).not.toHaveBeenCalled();
      });
    });
  });
});
