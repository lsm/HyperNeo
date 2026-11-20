#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectCodexAppServer,
  startCodexBootstrapServer,
  type CodexAppServer,
} from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import {
  type CodexDesktopAdapterDeps,
  queueCodexMessage,
} from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';

const codex = process.env.CODEX_CLI_PATH ?? 'codex';
const home = mkdtempSync(join(tmpdir(), 'codex-writer-'));
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
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
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

try {
  const owner = await startCodexBootstrapServer(codex);
  const started = (await owner.call('thread/start', { cwd: home })) as {
    thread: { id: string; path?: string | null };
  };
  const id = started.thread.id;
  await owner.call('thread/name/set', { threadId: id, name: 'Owned elsewhere' });
  const shared = await connect();
  const refusal = await shared.call('thread/resume', { threadId: id }).then(
    () => '',
    (error: unknown) => String(error)
  );
  check(
    'the shared app-server refuses to resume a thread another app-server writes',
    refusal.includes(`thread ${id} already has an active writer`),
    refusal
  );
  const deps = {
    appServer: async () => connect(),
    newId: () => crypto.randomUUID(),
    spawn: () => {
      throw new Error('Unexpected CLI fallback');
    },
    desktopRunning: async () => false,
  } as unknown as CodexDesktopAdapterDeps;
  const queued = await queueCodexMessage(
    {
      thread: {
        id,
        folder: home,
        title: 'Owned elsewhere',
        archived: 0,
        updatedAt: 1,
        rolloutPath: started.thread.path ?? join(home, 'missing.jsonl'),
      },
      roots: [],
    },
    'Continue after compaction.',
    deps,
    'queue'
  );
  check('production queueing accepts the send', queued.ok, JSON.stringify(queued));
  const list = (await owner.call('thread/queue/list', { threadId: id })) as {
    data: { input: { text: string }[] }[];
  };
  check(
    'the owning app-server holds the queued message',
    list.data.some((item) => item.input[0]?.text === 'Continue after compaction.'),
    JSON.stringify(list.data.map((item) => item.input[0]?.text))
  );
  await shared.close();
  await owner.close();
} finally {
  daemon.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(`failed=${failed}`);
process.exit(failed ? 1 : 0);
