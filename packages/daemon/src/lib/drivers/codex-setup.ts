import type { GlobalSettings } from '@hyperneo/shared/types/settings';
import {
  CODEX_BRIDGE_PORT,
  loadCodexBridgeToken,
  removeCodexBridgeToken,
} from './codex-app-server-bridge.ts';
import type { createCodexSetupHost } from './codex-setup-host.ts';

type Settings = NonNullable<GlobalSettings['codexAppServerBridge']>;
type Request = { undo?: boolean; noRemoteControl?: boolean };

function originalEnvironment(value: string | null, port: number) {
  const legacy = /^ws:\/\/(?:127\.0\.0\.1|localhost):47912(?:\/rpc|\/)?$/;
  const bridge = new RegExp(`^ws://127\\.0\\.0\\.1:${port}/rpc\\?token=[A-Za-z0-9_-]{43}$`);
  return value && (legacy.test(value) || bridge.test(value)) ? null : value;
}

export function createCodexSetup(
  host: ReturnType<typeof createCodexSetupHost>,
  read: () => Settings | undefined,
  write: (settings: Settings) => void
) {
  const shutdown = new AbortController();
  let tail = Promise.resolve();
  const url = (port: number, token: Buffer) => `ws://127.0.0.1:${port}/rpc?token=${token}`;

  async function apply({ undo, noRemoteControl }: Request) {
    const state = read() ?? { enabled: false };
    const signal = shutdown.signal;
    signal.throwIfAborted();
    if (undo) {
      if (state.enabled || state.originalUrl !== undefined) {
        const originalUrl = state.originalUrl ?? null;
        await host.atIdle(async () => {
          write({ ...state, enabled: false, originalUrl, decision: 'declined' });
          await host.setEnvironment(originalUrl);
          await host.close();
          await removeCodexBridgeToken();
        }, signal);
        await host.restartApp(signal);
      }
      write({ enabled: false, decision: 'declined' });
      return {
        ok: true as const,
        message:
          'To disable remote control, run codex app-server daemon disable-remote-control. Undo does not reinstall the old agents. See the macOS launchd documentation to install them manually.',
      };
    }

    const port = state.port ?? CODEX_BRIDGE_PORT;
    const originalUrl =
      state.originalUrl === undefined
        ? originalEnvironment(await host.environment(), port)
        : state.originalUrl;
    const removed = await host.migrate(signal);
    await host.startManaged();
    const token = await loadCodexBridgeToken(true);
    await host.startBridge(port, token);
    write({
      enabled: true,
      port,
      originalUrl,
      remoteControl: noRemoteControl ? 'skipped' : 'enabled',
    });
    await host.setEnvironment(url(port, token));
    if (!noRemoteControl && !(await host.remoteEnabled())) await host.enableRemote(signal);
    await host.restartApp(signal);
    return {
      ok: true as const,
      message: 'Codex setup is complete. HyperNeo must run at login to restore the bridge.',
      removed,
    };
  }

  return {
    manual(request: Request) {
      const job = tail.then(() => apply(request));
      tail = job.then(
        () => {},
        () => {}
      );
      return job;
    },
    async login() {
      const state = read();
      if (!state?.enabled) return;
      const port = state.port ?? CODEX_BRIDGE_PORT;
      const token = await loadCodexBridgeToken();
      if (state.originalUrl === undefined)
        write({ ...state, originalUrl: originalEnvironment(await host.environment(), port) });
      await host.setEnvironment(url(port, token));
      await host.startManaged();
      await host.startBridge(port, token);
    },
    async close() {
      shutdown.abort();
      await tail;
      await host.close();
    },
  };
}
