import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectCodexAppServer,
  startCodexBootstrapServer,
} from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import {
  createCodexDesktopAdapter,
  readCodexThread,
} from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { codexStatePath } from '../../../packages/daemon/src/storage/codex-desktop-read.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

assert.equal(process.env.NODE_ENV, 'test');
const codex = process.env.CODEX_CLI_PATH;
assert(codex?.startsWith('/') && existsSync(codex), 'Set CODEX_CLI_PATH to the Codex executable');
const home = mkdtempSync('/tmp/codex-archive-');
const codexHome = join(home, '.codex');
mkdirSync(codexHome);
const socket = join(home, 'control.sock');
const env = { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: codexHome };
Object.assign(process.env, env);
const daemon = spawn(codex, ['app-server', '--listen', `unix://${socket}`], {
  env,
  stdio: 'ignore',
});
const exited = new Promise((resolve) => daemon.once('close', resolve));

async function waitForSocket() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(socket)) return connectCodexAppServer(socket);
    await Bun.sleep(100);
  }
  throw new Error('Shared Codex app-server did not listen');
}

try {
  const desktop = await waitForSocket();
  try {
    const { thread } = (await desktop.call('thread/start', { cwd: home })) as {
      thread: { id: string };
    };
    const threadId = thread.id;
    await desktop.call('thread/name/set', { threadId, name: 'Shared archive probe' });
    const statePath = codexStatePath(home);
    assert.equal(readCodexThread(statePath, threadId)?.thread.archived, 0);
    const loaded = await desktop.call('thread/loaded/list', {});
    assert.deepEqual(loaded, { data: [threadId], nextCursor: null });
    console.log('PASS throwaway thread is open on the shared app-server');

    const adapter = createCodexDesktopAdapter({
      statePath,
      worktreesDir: join(codexHome, 'worktrees'),
      machine: 'synthetic',
      now: Date.now,
      spawn: spawnProcess,
      appServer: () => connectCodexAppServer(socket),
      bootstrapServer: () => startCodexBootstrapServer(codex),
      prepareDesktopProject: async () => {
        throw new Error('Unexpected project registration');
      },
      startDesktopTurn: async () => {
        throw new Error('Unexpected turn start');
      },
      folderExists: existsSync,
      makeFolder: mkdirSync,
      homeDir: home,
      gitCheckout: async () => null,
      newId: () => crypto.randomUUID(),
    });
    const result = await adapter.archive?.({ adapter: adapter.id, id: threadId }, () => null);
    const archived = readCodexThread(statePath, threadId)?.thread.archived;
    console.log(JSON.stringify({ result, archived }));
    assert.deepEqual(result, { ok: true, value: { archived: true } });
    assert.equal(archived, 1);
    console.log('PASS work archive persists the archived state');
  } finally {
    await desktop.close();
  }
} finally {
  daemon.kill();
  await exited;
  rmSync(home, { recursive: true, force: true });
}
