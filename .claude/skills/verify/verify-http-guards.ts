import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { resolveNeoEntry } from '../../../packages/shared/src/web-entry.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer, type ServerHandle } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const assets = join(run, 'asset-host/packages/web/dist');
mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, 'index.html'), 'Synthetic preview');
const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  standalone: true, verbose: false,
});
const helpers = ['session-tool-activation', 'tools-live-capture', 'error-workflow-server', 'project-start-home', 'model-discovery-isolation', 'driver-health', 'catalog-tool-defaults', 'claude-login-retry'];
const receipts: { helper: string; asset?: number; refused?: number; rpc?: boolean; error?: string }[] = [];
let front: ServerHandle | ReturnType<typeof Bun.serve> | undefined;
let socket: WebSocket | undefined;
function fetchHandler(helper: string) {
  const path = `.claude/skills/verify/${helper}.ts`;
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions: (ts.ArrowFunction | ts.MethodDeclaration)[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'guardRequest') {
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isArrowFunction(parent) && !ts.isMethodDeclaration(parent)) parent = parent.parent;
      assert(parent && (ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent)));
      functions.push(parent);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(functions.length, 1, `${helper} must have one owned fetch handler`);
  const fn = functions[0];
  const expression = ts.isMethodDeclaration(fn)
    ? `async function${fn.getText(source).slice(fn.name.end - fn.getStart(source))}`
    : fn.getText(source);
  const code = ts.transpileModule(`const handler = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  const instantiate = new Function('app', 'owned', 'daemon', 'web', 'root', 'dist', 'join', 'resolve', 'resolveNeoEntry', 'process', `${code}\nreturn handler;`);
  const fixtureProcess = Object.create(process);
  fixtureProcess.cwd = () => join(run, 'asset-host');
  return instantiate(app, app, app, { fetch: () => new Response('Synthetic preview') }, assets, assets, join, resolve, resolveNeoEntry, fixtureProcess);
}
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  for (const helper of helpers) {
    const receipt: (typeof receipts)[number] = { helper };
    receipts.push(receipt);
    try {
      const fetch = fetchHandler(helper);
      const websocket = createWebSocketHandlers(app.transport, app.sessionManager);
      front = helper === 'model-discovery-isolation'
        ? await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch, websocket })
        : Bun.serve({ hostname: '127.0.0.1', port: 0, fetch, websocket });
      assert.notEqual(front.port, 8399);
      const base = `http://127.0.0.1:${front.port}`;
      const page = await globalThis.fetch(`${base}/index.html`, { signal: AbortSignal.timeout(5_000) });
      receipt.asset = page.status;
      assert.equal(page.status, 200, `${helper} must continue past the guard`);
      assert.equal(await page.text(), 'Synthetic preview');
      const denied = await globalThis.fetch(`${base}/guard`, { method: 'POST', headers: { origin: 'https://untrusted.invalid' }, signal: AbortSignal.timeout(5_000) });
      receipt.refused = denied.status;
      assert.equal(denied.status, 403);
      socket = createLocalSocket(`${base.replace('http:', 'ws:')}/ws`);
      await new Promise<void>((done, fail) => {
        const timeout = setTimeout(() => fail(new Error(`${helper} WebSocket timed out`)), 3_000);
        socket!.onopen = () => { clearTimeout(timeout); done(); };
        socket!.onerror = () => { clearTimeout(timeout); fail(new Error(`${helper} WebSocket refused`)); };
      });
      const reply = await new Promise<{ ok: boolean; reason: string }>((done, fail) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => fail(new Error(`${helper} RPC timed out`)), 5_000);
        socket!.onmessage = (event) => {
          const reply = JSON.parse(String(event.data));
          if (reply.requestId !== id) return;
          clearTimeout(timeout);
          if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
        };
        socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'neo.ask.read', input: { askId: 'synthetic-missing' } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      assert.equal(reply.ok, false);
      assert(reply.reason.startsWith('not_found:'));
      receipt.rpc = true;
    } catch (error) { receipt.error = String(error); }
    finally { socket?.close(); socket = undefined; front?.stop(true); front = undefined; }
  }
  writeFileSync(join(run, 'evidence/verify-http-guards.json'), JSON.stringify({ receipts }, null, 2));
  assert(receipts.every((receipt) => receipt.rpc && !receipt.error), 'Every borrowed proof-server handler must serve assets and complete authenticated RPC');
} finally {
  socket?.close(); front?.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ allServersStopped: true }));
}
