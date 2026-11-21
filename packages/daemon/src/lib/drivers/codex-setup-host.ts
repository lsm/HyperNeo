import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';
import { startCodexAppServerBridge } from './codex-app-server-bridge.ts';
import { codexCommand, connectCodexAppServer, type CodexAppServer } from './codex-app-server.ts';
import { createCodexCutover } from './codex-cutover.ts';
import { codexAppServerSocketPath } from './worker-directories.ts';

const environmentKey = 'CODEX_APP_SERVER_WS_URL';
const legacyLabels = ['ai.hyperneo.codex-app-setup', 'ai.hyperneo.codex-app-forwarder'] as const;
const bundle = 'com.openai.codex';
const loadedThreads = z.object({ data: z.array(z.string()), nextCursor: z.string().nullish() });
const thread = z.object({
  thread: z.object({
    status: z.object({ type: z.enum(['notLoaded', 'idle', 'systemError', 'active']) }),
  }),
});
const remote = z.object({ status: z.enum(['disabled', 'connecting', 'connected', 'errored']) });

async function managedIdle(server: CodexAppServer) {
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof loadedThreads> = loadedThreads.parse(
      await server.call('thread/loaded/list', cursor ? { cursor } : {})
    );
    for (const threadId of page.data) {
      const response = thread.parse(
        await server.call('thread/read', { threadId, includeTurns: false })
      );
      if (response.thread.status.type === 'active') return false;
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return true;
}

export function createCodexSetupHost(spawn: SpawnFn = spawnProcess, home = homedir()) {
  const socket = codexAppServerSocketPath(join(home, '.codex'));
  const target = (label: string) => `gui/${process.getuid?.()}/${label}`;
  const plist = (label: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const launchctl = async (args: string[], capture = false) => {
    const child = spawn(['/bin/launchctl', ...args], {
      stdout: capture ? 'pipe' : 'ignore',
      stderr: 'ignore',
    });
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, text };
  };
  const required = async (args: string[], failure: string) => {
    const code = await Promise.resolve()
      .then(() => spawn(args, { stdout: 'ignore', stderr: 'ignore' }).exited)
      .catch(() => -1);
    if (code !== 0) throw new Error(failure);
  };
  const managed = async <T>(read: (server: CodexAppServer) => Promise<T>) => {
    const present = await stat(socket).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    );
    if (!present) return null;
    const server = await connectCodexAppServer(socket);
    try {
      return await read(server);
    } finally {
      await server.close();
    }
  };
  const gate = createCodexCutover(async () => (await managed(managedIdle)) ?? true);
  let close: (() => Promise<void>) | undefined;
  return {
    ...gate,
    async startBridge(port?: number) {
      close ??= await startCodexAppServerBridge(port);
    },
    async close() {
      await close?.();
      close = undefined;
    },
    async environment() {
      const { code, text } = await launchctl(['getenv', environmentKey], true);
      return code === 0 && text ? text.replace(/\r?\n$/, '') : null;
    },
    setEnvironment: (value: string | null) =>
      required(
        [
          '/bin/launchctl',
          ...(value === null ? ['unsetenv', environmentKey] : ['setenv', environmentKey, value]),
        ],
        'Could not update the Codex login environment.'
      ),
    startManaged: () =>
      required(
        [codexCommand(), 'app-server', 'daemon', 'start'],
        'Could not start the managed Codex daemon.'
      ),
    async remoteEnabled() {
      return (
        (await managed(
          async (server) =>
            remote.parse(await server.call('remoteControl/status/read', {})).status !== 'disabled'
        )) ?? false
      );
    },
    async migrate(signal?: AbortSignal) {
      const removed: string[] = [];
      for (const label of legacyLabels) {
        const loaded = async () => (await launchctl(['print', target(label)])).code === 0;
        if (!existsSync(plist(label)) && !(await loaded())) continue;
        await gate.atIdle(async () => {
          if (await loaded())
            await required(
              ['/bin/launchctl', 'bootout', target(label)],
              `Could not remove the legacy Codex agent ${label}.`
            );
          await rm(plist(label), { force: true });
        }, signal);
        removed.push(label);
      }
      return removed;
    },
    restartApp: (signal?: AbortSignal) =>
      gate.atIdle(async () => {
        const quit = `
        ObjC.import('AppKit');
        const running = () => $.NSRunningApplication.runningApplicationsWithBundleIdentifier('${bundle}');
        const apps = running();
        for (let i = 0; i < Number(apps.count); i++) apps.objectAtIndex(i).terminate;
        for (let i = 0; Number(running().count); i++) {
          if (i === 30) throw Error('Codex did not quit');
          delay(0.5);
        }
      `;
        await required(
          ['/usr/bin/osascript', '-l', 'JavaScript', '-e', quit],
          'Could not quit Codex Desktop.'
        );
        await required(['/usr/bin/open', '-b', bundle], 'Could not reopen Codex Desktop.');
      }, signal),
    enableRemote: (signal?: AbortSignal) =>
      gate.atIdle(
        () =>
          required(
            [codexCommand(), 'app-server', 'daemon', 'enable-remote-control'],
            'Could not enable Codex remote control.'
          ),
        signal
      ),
  };
}
