import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { CODEX_WORKER_INSTRUCTIONS } from '../../../packages/prompts/src/mod.ts';
import {
  startCodexBootstrapServer,
  type CodexAppServer,
} from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { createCodexDesktopAdapter } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.CODEX_HOME, join(run, 'home/.codex'));
assert(!existsSync(process.env.CODEX_HOME));
const folder = join(run, 'workspace');
mkdirSync(folder, { recursive: true });
mkdirSync(process.env.CODEX_HOME, { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const message = 'Synthetic prompt-delivery proof; do not call any tools.';
let capture!: (body: Record<string, unknown>) => void;
const captured = new Promise<Record<string, unknown>>((done) => {
  capture = done;
});
const http = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.method === 'POST' && request.url?.endsWith('/responses')) {
    capture(JSON.parse(body));
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'Synthetic proof ends at model input; no tools execute.' },
      })
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
const address = http.address();
assert(address && typeof address !== 'string' && address.port !== 8399);
writeFileSync(
  join(process.env.CODEX_HOME, 'config.toml'),
  `model = "synthetic-model"
model_provider = "proof"
[model_providers.proof]
name = "Local synthetic proof"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
`
);
let resumed: CodexAppServer | undefined;
let bootstrap: CodexAppServer | undefined;
const starts: unknown[] = [];
const turns: unknown[] = [];
try {
  const adapter = createCodexDesktopAdapter({
    statePath: join(process.env.CODEX_HOME, 'state_5.sqlite'),
    worktreesDir: join(run, 'worktrees'),
    machine: 'proof',
    now: Date.now,
    spawn: () => {
      throw new Error('No Git or GUI process is needed.');
    },
    appServer: async () => {
      throw new Error('No live app connection is permitted.');
    },
    bootstrapServer: async () => {
      const server = await startCodexBootstrapServer();
      bootstrap = server;
      return {
        close: server.close,
        call: async (method, params) => {
          if (method === 'thread/start') starts.push(params);
          return server.call(method, params);
        },
      };
    },
    prepareDesktopProject: async () => {
      const reply = (await bootstrap!.call('project/create', {
        name: 'Synthetic',
        roots: [{ path: folder }],
        idempotencyKey: crypto.randomUUID(),
      })) as { project: { id: string } };
      return reply.project.id;
    },
    startDesktopTurn: async (threadId, params) => {
      turns.push(params);
      resumed = await startCodexBootstrapServer();
      await resumed.call('thread/resume', { threadId });
      await resumed.call('turn/start', params);
    },
    folderExists: existsSync,
    makeFolder: (path) => mkdirSync(path),
    homeDir: process.env.HOME!,
    gitCheckout: async () => null,
    newId: crypto.randomUUID,
  });
  const result = await adapter.start!(
    { place: { machine: 'proof', folder }, title: 'Synthetic PR-link prompt', message },
    { from: 'user', caller: { source: 'rpc' } }
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('No local model request received')), 20_000);
  });
  let body: Record<string, unknown>;
  try {
    body = await Promise.race([captured, timedOut]);
  } finally {
    clearTimeout(timeout!);
  }
  writeFileSync(join(run, 'evidence/model-input.json'), JSON.stringify(body, null, 2));
  const input = body.input as { role: string; content: { text?: string }[] }[];
  assert(
    input.some(
      (item) =>
        item.role === 'user' &&
        item.content.some((part) => part.text === `${message}\n${CODEX_WORKER_INSTRUCTIONS}`)
    )
  );
  assert(JSON.stringify(body).includes(message));
  writeFileSync(
    join(run, 'evidence/proof.json'),
    JSON.stringify(
      {
        result,
        starts,
        turns,
        modelRequest: body,
        conclusion:
          'Fresh isolated Codex resumed the driver-created thread and included the exact one-line guidance in its model input. No model response or tool action was executed.',
      },
      null,
      2
    )
  );
  console.log(join(run, 'evidence/proof.json'));
} finally {
  await resumed?.close();
  await new Promise<void>((done) => http.close(() => done()));
}
