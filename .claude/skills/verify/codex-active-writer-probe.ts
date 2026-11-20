#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const requests: string[] = [];
const model = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response('synthetic model', { status: 500 });
  },
});
writeFileSync(
  join(process.env.CODEX_HOME, 'config.toml'),
  [
    'model_provider = "synthetic"',
    '[model_providers.synthetic]',
    'name = "Synthetic"',
    `base_url = "http://127.0.0.1:${model.port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n')
);
const env = { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: process.env.CODEX_HOME };
const daemon = spawn(codex, ['app-server', '--listen', `unix://${socket}`], {
  env,
  stdio: 'ignore',
});
const daemonExited = new Promise((resolve) => daemon.once('exit', resolve));
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

const queuedTexts = async (server: CodexAppServer, threadId: string) =>
  (
    (await server.call('thread/queue/list', { threadId })) as {
      data: { input: { text: string }[] }[];
    }
  ).data.map((item) => item.input[0]?.text);

let owner: CodexAppServer | undefined;
try {
  owner = await startCodexBootstrapServer(codex);
  const started = (await owner.call('thread/start', {
    cwd: home,
    model: 'synthetic',
    approvalPolicy: 'never',
  })) as { thread: { id: string; path?: string | null } };
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

  await shared.call('thread/queue/add', {
    threadId: id,
    clientUserMessageId: 'probe-queue',
    input: [{ type: 'text', text: 'Queued from the shared server.' }],
  });
  await Bun.sleep(6000);
  check(
    'an idle owner never starts input another app-server queued',
    requests.length === 0 && (await queuedTexts(owner, id)).length === 1,
    `modelRequests=${requests.length}`
  );
  const start = await shared.call('thread/queue/start', { threadId: id }).then(
    () => '',
    (error: unknown) => String(error)
  );
  check('the shared app-server cannot start that queued input', start !== '', start);
  await owner.call('thread/queue/start', { threadId: id });
  for (let wait = 0; wait < 50 && requests.length === 0; wait++) await Bun.sleep(100);
  check(
    'control: the owner itself starts the queued input',
    requests.length > 0 && (await queuedTexts(owner, id)).length === 0,
    `modelRequests=${requests.length}`
  );
  await Bun.sleep(1000);

  const deps = {
    appServer: async () => connect(),
    newId: () => crypto.randomUUID(),
    spawn: () => {
      throw new Error('Unexpected CLI fallback');
    },
    desktopRunning: async () => false,
  } as unknown as CodexDesktopAdapterDeps;
  const sent = await queueCodexMessage(
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
  check(
    'production queueing refuses plainly, as not sent',
    !sent.ok &&
      sent.reason === 'not_delivered' &&
      sent.notSent === true &&
      sent.detail.startsWith('The Codex app has this thread open'),
    JSON.stringify(sent)
  );
  check(
    'nothing waits in the owner queue after the refusal',
    (await queuedTexts(owner, id)).length === 0
  );
  await shared.close();
} finally {
  await owner?.close();
  daemon.kill();
  await daemonExited;
  model.stop(true);
  await Bun.sleep(500);
  rmSync(home, { recursive: true, force: true });
}
console.log(`failed=${failed}`);
process.exit(failed ? 1 : 0);
