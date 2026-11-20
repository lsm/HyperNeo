#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectCodexAppServer,
  startCodexBootstrapServer,
  type CodexAppServer,
} from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { codexDesktopIpcListening } from '../../../packages/daemon/src/lib/drivers/codex-desktop-handoff.ts';

const codex = process.env.CODEX_CLI_PATH ?? 'codex';
const home = mkdtempSync(join(tmpdir(), 'codex-started-'));
mkdirSync(join(home, '.codex'));
const socket = join(home, 'control.sock');
process.env.HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
const env = { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: process.env.CODEX_HOME };
const daemon = spawn(codex, ['app-server', '--listen', `unix://${socket}`], {
  env,
  stdio: 'ignore',
});
let failed = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
};

async function connect(): Promise<CodexAppServer> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(socket)) {
      const server = await connectCodexAppServer(socket).catch(() => null);
      if (server) return server;
    }
    await Bun.sleep(100);
  }
  throw new Error('shared app-server did not listen');
}

function startedIds(server: CodexAppServer) {
  const ids: string[] = [];
  server.onNotification((note) => {
    const id = (note.params as { thread?: { id?: string } } | undefined)?.thread?.id;
    if (note.method === 'thread/started' && id) ids.push(id);
  });
  return ids;
}

try {
  const stale = join(home, 'stale-ipc.sock');
  spawnSync('python3', [
    '-I',
    '-c',
    'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])',
    stale,
  ]);
  check('a missing Desktop IPC socket counts as absent', !(await codexDesktopIpcListening(join(home, 'missing.sock'))));
  check('a stale Desktop IPC path counts as absent', !(await codexDesktopIpcListening(stale)));
  const app = await connect();
  check('a listening socket counts as present', await codexDesktopIpcListening(socket));
  const seen = startedIds(app);
  const shared = await connect();
  const onShared = (await shared.call('thread/start', { cwd: home })) as { thread: { id: string } };
  await Bun.sleep(500);
  check(
    'the app connection hears thread/started for a thread created on the shared app-server',
    seen.includes(onShared.thread.id)
  );

  const bootstrap = await startCodexBootstrapServer(codex);
  const onBootstrap = (await bootstrap.call('thread/start', { cwd: home })) as {
    thread: { id: string };
  };
  await bootstrap.call('thread/name/set', { threadId: onBootstrap.thread.id, name: 'Probe 1' });
  await bootstrap.close();
  await shared.call('thread/resume', { threadId: onBootstrap.thread.id });
  await Bun.sleep(500);
  check(
    'a thread created on a spawned app-server stays unheard by the app even after a shared resume',
    !seen.includes(onBootstrap.thread.id)
  );
  await app.close();
  await shared.close();
} finally {
  daemon.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(`failed=${failed}`);
process.exit(failed ? 1 : 0);
