import { describe, expect, it, beforeEach, mock, afterEach, spyOn } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { setupDialogHandlers } from '../../../../src/lib/rpc-handlers/dialog-handlers';

const BunRef: typeof Bun =
  (globalThis as Record<string, unknown>).Bun ??
  (((globalThis as Record<string, unknown>).Bun = {
    spawn: () => {
      throw new Error('Bun.spawn stub — tests must spy on Bun.spawn');
    },
  }) as unknown as typeof Bun);

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockProcess(stdout: string, exitCode: number = 0) {
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
    stdout: stdoutStream,
    stderr: stderrStream,
    exited: Promise.resolve(exitCode),
  };
}

function createHangingMockProcess() {
  let resolveExit: (exitCode: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const createOpenStream = () =>
    new ReadableStream<Uint8Array>({
      start() {},
    });
  const kill = mock(() => resolveExit(143));

  return {
    stdout: createOpenStream(),
    stderr: createOpenStream(),
    exited,
    kill,
  };
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
    leaveChannel: mock(async () => {}),
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
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    messageHubData = createMockMessageHub();
    originalPlatform = process.platform;

    spawnSpy = spyOn(BunRef, 'spawn').mockImplementation(
      () => createMockProcess('') as unknown as ReturnType<typeof Bun.spawn>
    );

    setupDialogHandlers(messageHubData.hub);
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
      spawnSpy.mockImplementation(
        () => createMockProcess('/Users/test/project\n') as unknown as ReturnType<typeof Bun.spawn>
      );
      const handler = messageHubData.handlers.get('dialog.pickFolder');
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
      const result = handler!({}, {});
      expect(result).toBeInstanceOf(Promise);
      const resolved = await result;
      expect(resolved).toEqual({ path: '/Users/test/project' });
    });

    it('returns null when Bun.spawn throws an error (error-handling path)', async () => {
      setPlatform('darwin');
      spawnSpy.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const handler = messageHubData.handlers.get('dialog.pickFolder')!;
      const result = await handler({}, {});

      expect(result).toEqual({ path: null });
    });

    describe('macOS (darwin)', () => {
      it('calls osascript with choose folder and returns trimmed path', async () => {
        setPlatform('darwin');
        spawnSpy.mockImplementation(
          () =>
            createMockProcess('/Users/test/workspace\n') as unknown as ReturnType<typeof Bun.spawn>
        );

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: '/Users/test/workspace' });
        expect(spawnSpy).toHaveBeenCalledWith(
          ['osascript', '-e', expect.stringContaining('choose folder')],
          expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
        );
      });

      it('returns null when user cancels (osascript exits with non-zero code)', async () => {
        setPlatform('darwin');
        spawnSpy.mockImplementation(
          () => createMockProcess('', 1) as unknown as ReturnType<typeof Bun.spawn>
        );

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });

      it('closes the folder picker process when the daemon-side timeout expires', async () => {
        setPlatform('darwin');
        const proc = createHangingMockProcess();
        spawnSpy.mockImplementation(() => proc as unknown as ReturnType<typeof Bun.spawn>);

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({ timeoutMs: 1 }, {});

        expect(result).toEqual({ path: null });
        expect(proc.kill).toHaveBeenCalledTimes(1);
      });
    });

    describe('Linux', () => {
      it('uses zenity when available and returns trimmed path', async () => {
        setPlatform('linux');
        spawnSpy.mockImplementation(
          (args: string[]) =>
            createMockProcess(
              args[0] === 'which' ? '/usr/bin/zenity\n' : '/home/user/workspace\n'
            ) as unknown as ReturnType<typeof Bun.spawn>
        );

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: '/home/user/workspace' });
        const calls = spawnSpy.mock.calls as unknown as Array<[string[]]>;
        const zenityCall = calls.find(([args]) => args[0] === 'zenity');
        expect(zenityCall).toBeDefined();
        expect(zenityCall![0]).toContain('--directory');
      });

      it('falls back to kdialog when zenity is not available', async () => {
        setPlatform('linux');
        spawnSpy.mockImplementation((args: string[]) => {
          if (args[0] === 'which' && args[1] === 'zenity') {
            return createMockProcess('', 1) as unknown as ReturnType<typeof Bun.spawn>;
          }
          if (args[0] === 'which' && args[1] === 'kdialog') {
            return createMockProcess('/usr/bin/kdialog\n') as unknown as ReturnType<
              typeof Bun.spawn
            >;
          }
          return createMockProcess('/home/user/workspace\n') as unknown as ReturnType<
            typeof Bun.spawn
          >;
        });

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: '/home/user/workspace' });
        const calls = spawnSpy.mock.calls as unknown as Array<[string[]]>;
        const kdialogCall = calls.find(([args]) => args[0] === 'kdialog');
        expect(kdialogCall).toBeDefined();
      });

      it('returns null when neither zenity nor kdialog is available', async () => {
        setPlatform('linux');
        spawnSpy.mockImplementation(
          () => createMockProcess('', 1) as unknown as ReturnType<typeof Bun.spawn>
        );

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });

      it('returns null when user cancels zenity', async () => {
        setPlatform('linux');
        spawnSpy.mockImplementation((args: string[]) => {
          if (args[0] === 'which') {
            return createMockProcess('/usr/bin/zenity\n') as unknown as ReturnType<
              typeof Bun.spawn
            >;
          }
          return createMockProcess('', 1) as unknown as ReturnType<typeof Bun.spawn>;
        });

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: null });
      });
    });

    describe('Windows (win32)', () => {
      it('calls powershell with FolderBrowserDialog and returns trimmed path', async () => {
        setPlatform('win32');
        spawnSpy.mockImplementation(
          () =>
            createMockProcess('C:\\Users\\test\\workspace\r\n') as unknown as ReturnType<
              typeof Bun.spawn
            >
        );

        const handler = messageHubData.handlers.get('dialog.pickFolder')!;
        const result = await handler({}, {});

        expect(result).toEqual({ path: 'C:\\Users\\test\\workspace' });
        expect(spawnSpy).toHaveBeenCalledWith(
          ['powershell', '-Command', expect.stringContaining('FolderBrowserDialog')],
          expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' })
        );
      });

      it('returns null when user cancels on Windows', async () => {
        setPlatform('win32');
        spawnSpy.mockImplementation(
          () => createMockProcess('', 0) as unknown as ReturnType<typeof Bun.spawn>
        );

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
        expect(spawnSpy).not.toHaveBeenCalled();
      });
    });
  });
});
