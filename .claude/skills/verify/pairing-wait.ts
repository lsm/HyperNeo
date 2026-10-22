import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
const [mode, directory] = process.argv.slice(2),
  run = resolve(directory);
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const requireWeb = createRequire(join(root, 'packages/web/package.json'));
const { Window } = await import(pathToFileURL(requireWeb.resolve('happy-dom')).href);
const source = `import { h, render } from ${JSON.stringify(requireWeb.resolve('preact').replace('/dist/preact.js', '/dist/preact.module.js'))};
import { PairPage } from ${JSON.stringify(join(root, 'packages/web/src/components/pairing/PairPage.tsx'))};
export const mount=()=>render(h(PairPage),document.getElementById('app'));
export const unmount=()=>render(null,document.getElementById('app'));`;
writeFileSync(join(run, 'entry.mjs'), source);
const built = await Bun.build({
  entrypoints: [join(run, 'entry.mjs')],
  target: 'browser',
  format: 'esm',
});
assert(built.success, 'Could not bundle the actual PairPage');
await Bun.write(join(run, 'pair-page.mjs'), built.outputs[0]);
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const base = `http://127.0.0.1:${app.server.port}`,
  nativeFetch = globalThis.fetch;
const win = new Window({ url: base + '/pair' });
win.document.body.innerHTML = '<div id="app"></div>';
for (const name of [
  'window',
  'document',
  'location',
  'history',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'HashChangeEvent',
  'CustomEvent',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? win : win[name],
  });
for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'])
  globalThis[name] = win[name].bind(win);
const statuses: number[] = [];
let cookie: string | undefined;
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(new URL(String(input), base), {
    ...init,
    headers: { ...init?.headers, Origin: base },
  });
  statuses.push(response.status);
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  return response;
};
const sockets: WebSocket[] = [];
const evidence: Record<string, unknown> = { mode, statuses };
let page: { mount(): void; unmount(): void } | undefined;
const wait = async (check: () => boolean, ms = 8000) => {
  const until = Date.now() + ms;
  while (!check()) {
    assert(Date.now() < until, 'observable condition timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const cli = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, join(root, 'packages/cli/main.ts'), ...args], {
    cwd: root,
    env: { ...process.env, HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const text = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, 'CLI refused');
  return JSON.parse(text);
};
const connect = async (headers: Record<string, string> = {}) => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers });
  sockets.push(ws);
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error('socket unavailable'));
  });
  return (name: string, input: unknown = {}) =>
    new Promise<any>((done, fail) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => fail(new Error(name + ' timeout')), 10000);
      ws.onmessage = (e) => {
        const r = JSON.parse(String(e.data));
        if (r.id !== id && r.requestId !== id) return;
        clearTimeout(timer);
        r.error ? fail(new Error(JSON.stringify(r.error))) : done(r.data);
      };
      ws.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method: 'operation.invoke',
          data: { name, input },
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });
};
const button = (name: string) =>
  Array.from(win.document.querySelectorAll('button')).find(
    (element: any) => element.textContent.trim() === name
  ) as HTMLButtonElement | undefined;
const mount = (code: string) => {
  win.history.replaceState(null, '', '/pair#' + code);
  page!.mount();
};
try {
  const bootstrap = await cli('pair', '--name', 'Synthetic approver');
  const response = await nativeFetch(base + '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: bootstrap.code, name: 'Synthetic approver' }),
  });
  const paired = (await response.json()) as any;
  const approve = await connect({ Authorization: `Bearer ${paired.credential}` }),
    unpaired = await connect();
  const next = await cli('pair', '--name', 'Synthetic waiting browser');
  const pending = await unpaired('device.pair.pending');
  evidence.unpairedPendingRefused = !pending.ok;
  page = await import(pathToFileURL(join(run, 'pair-page.mjs')).href);
  mount(next.code);
  button('Pair this browser')!.click();
  await wait(() => statuses.includes(403));
  evidence.initialText = win.document.body.textContent;
  if (mode === 'verify') await wait(() => statuses.length >= 2);
  assert.equal((await approve('device.pair.approve', { codeId: next.codeId })).ok, true);
  if (mode === 'before') {
    await new Promise((r) => setTimeout(r, 2500));
    assert(!win.document.body.textContent.includes('This browser is paired.'));
    assert.deepEqual(statuses, [403]);
    console.log(
      'REPRODUCED: actual PairPage stops after 403; approval elsewhere does not complete pairing.'
    );
  } else {
    assert.equal(pending.ok, false);
    await wait(() => win.document.body.textContent.includes('This browser is paired.'));
    assert.equal(statuses.at(-1), 200);
    assert(statuses.slice(0, -1).every((status) => status === 403));
    assert(statuses.filter((status) => status === 403).length >= 2);
    assert(cookie);
    assert.equal(win.location.hash, '');
    const browser = await connect({ Cookie: cookie! });
    assert.equal((await browser('device.list')).ok, true);
    evidence.pairedText = win.document.body.textContent;
    page.unmount();
    const cancelled = await cli('pair', '--name', 'Synthetic cancelled browser');
    mount(cancelled.code);
    button('Pair this browser')!.click();
    await wait(
      () =>
        statuses.at(-1) === 403 &&
        win.document.body.textContent.includes('Waiting for Allow on a paired phone or browser.')
    );
    button('Stop waiting')!.click();
    const count = statuses.length;
    await approve('device.pair.approve', { codeId: cancelled.codeId });
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(statuses.length, count);
    assert(!win.document.body.textContent.includes('This browser is paired.'));
    evidence.cancelledWithoutRedemption = true;
    console.log(
      'PASS: actual bundled PairPage plus isolated daemon pairs after one submit and Allow elsewhere; unpaired pending refused, browser identity active, cancellation prevents later redemption.'
    );
  }
} finally {
  page?.unmount();
  globalThis.fetch = nativeFetch;
  for (const ws of sockets) ws.close();
  await app.cleanup();
  await win.happyDOM.close();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
