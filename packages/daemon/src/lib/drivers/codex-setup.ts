import type { GlobalSettings } from '@hyperneo/shared/types/settings';
import { Logger } from '../logger.ts';
import {
  CODEX_BRIDGE_PORT,
  loadCodexBridgeToken,
  readCodexBridgeToken,
  removeCodexBridgeToken,
} from './codex-app-server-bridge.ts';
import type { createCodexSetupHost } from './codex-setup-host.ts';
import type { codexSetupQuestion } from './codex-setup-question.ts';

type Settings = NonNullable<GlobalSettings['codexAppServerBridge']>;
type Request = { undo?: boolean; noRemoteControl?: boolean };
const log = new Logger('codex-setup');

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
  let question: ReturnType<typeof codexSetupQuestion> | undefined;
  let pendingCheck = false;
  let checkAgain = false;
  let used = false;
  const url = (port: number, token: Buffer) => `ws://127.0.0.1:${port}/rpc?token=${token}`;
  const enqueue = <T>(run: () => Promise<T>) => {
    const job = tail.then(run);
    tail = job.then(
      () => {},
      () => {}
    );
    return job;
  };

  async function apply({ undo, noRemoteControl }: Request, approved = false) {
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
    const token = await loadCodexBridgeToken(!approved);
    await host.startBridge(port, token);
    const configured: Settings = {
      enabled: true,
      port,
      originalUrl,
      remoteControl: noRemoteControl ? 'skipped' : 'enabled',
    };
    write(
      approved ? { ...configured, decision: 'approved', questionId: state.questionId } : configured
    );
    await host.setEnvironment(url(port, token));
    if (!noRemoteControl && !(await host.remoteEnabled())) await host.enableRemote(signal);
    await host.restartApp(signal);
    if (approved) write(configured);
    return {
      ok: true as const,
      message: 'Codex setup is complete. HyperNeo must run at login to restore the bridge.',
      removed,
    };
  }

  async function configured(state: Settings) {
    const token = state.enabled && (await readCodexBridgeToken());
    return (
      !!token &&
      (await host.environment()) === url(state.port ?? CODEX_BRIDGE_PORT, token) &&
      (state.remoteControl === 'skipped' ? await host.managedRunning() : await host.remoteEnabled())
    );
  }

  function check() {
    const card = question;
    if (!card || shutdown.signal.aborted) return;
    if (pendingCheck) {
      checkAgain = true;
      return;
    }
    pendingCheck = true;
    void enqueue(async () => {
      if (shutdown.signal.aborted) return;
      let state = read() ?? { enabled: false };
      if (state.decision === 'declined') {
        if (state.questionId) card.retire(state.questionId, false);
        return;
      }
      if (!state.decision) {
        if ((await configured(state).catch(() => false)) || shutdown.signal.aborted) return;
        state = { ...state, questionId: crypto.randomUUID(), decision: 'asked' };
        write(state);
      }
      if (state.decision === 'asked' && state.questionId) {
        const id = state.questionId;
        await card.open(id);
        const accepted = card.answer(id);
        if (accepted === undefined) return;
        state = { ...state, decision: accepted ? 'approved' : 'declined' };
        write(state);
        if (!accepted) {
          card.retire(id, false);
          return;
        }
      }
      if (state.decision === 'approved') {
        if (state.questionId) card.retire(state.questionId, true);
        await apply({ noRemoteControl: state.remoteControl === 'skipped' }, true);
      }
    })
      .catch((error) => {
        if (!shutdown.signal.aborted) log.warn('Automatic Codex setup could not complete.', error);
      })
      .finally(() => {
        pendingCheck = false;
        if (checkAgain) {
          checkAgain = false;
          check();
        }
      });
  }

  return {
    bindQuestion(card: ReturnType<typeof codexSetupQuestion>) {
      question = card;
    },
    check,
    firstUse() {
      if (!used || read()?.decision === 'approved') check();
      used = true;
    },
    manual(request: Request) {
      return enqueue(async () => {
        shutdown.signal.throwIfAborted();
        const state = read();
        if (state?.questionId) question?.retire(state.questionId, !request.undo);
        if (state?.decision && !request.undo)
          write({ ...state, decision: undefined, questionId: undefined });
        return apply(request);
      });
    },
    async login() {
      const state = read();
      if (!state?.enabled) return;
      const port = state.port ?? CODEX_BRIDGE_PORT;
      const token = await readCodexBridgeToken(true);
      if (!token) return;
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
