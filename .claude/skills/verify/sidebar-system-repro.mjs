import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage();
  let workChecks = 0;
  page.on('websocket', (socket) => socket.on('framesent', ({payload}) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.method === 'operation.invoke' && message.data?.name === 'work.find') workChecks++;
    } catch {}
  }));
  await page.goto(`http://127.0.0.1:${port}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Sidebar check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`http://127.0.0.1:${port}/sessions`);
  await page.getByRole('button', { name: 'New session in neo-read' }).waitFor({ state: 'attached' });
  await page.getByTestId('project-group-header').filter({ hasText: 'neo-read' }).hover();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Remove project neo-read"]')?.disabled, null, {timeout: 15000});
  await page.screenshot({ path: `${run}/evidence/sidebar-system-hover.png` });
  const archived = page.getByRole('button', {name: 'Remove project archived-chat'});
  await archived.waitFor({state: 'attached'});
  assert(await archived.isDisabled());
  assert.equal(await archived.getAttribute('title'), 'Project has chats, including archived chats');
  console.log('Archived chats remain protected with an explicit reason');
  const remote = page.getByRole('button', {name: 'Remove project remote-work'});
  await remote.waitFor({state: 'attached'});
  assert(await remote.isDisabled());
  assert.equal(await remote.getAttribute('title'), 'Cannot check all work for this project');
  const folderless = page.getByRole('button', {name: 'Remove project folderless'});
  await folderless.click({timeout: 15000});
  await page.getByRole('button', {name: 'Forget project'}).click();
  await folderless.waitFor({state:'detached', timeout:15000});
  console.log('Forgot a folderless project; remote work remains protected');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Remove project refused"]')?.disabled, null, {timeout:15000});
  const priorChecks = workChecks;
  await page.evaluate(async (folder) => {
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const id = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session creation timed out')), 10000);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id && message.requestId !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.data);
      };
      socket.send(JSON.stringify({id, type:'REQ', sessionId:'global', method:'session.create', data:{title:'Unrelated update', workspacePath:folder, config:{queryMode:'manual'}}, timestamp:new Date().toISOString(), version:'1.0.0'}));
    });
    socket.close();
  }, `${run}/projects/beta`);
  await page.getByText('Unrelated update').waitFor({timeout:15000});
  await page.waitForTimeout(1000);
  assert.equal(workChecks, priorChecks, 'unrelated session changes must not rescan projects');
  console.log('Unrelated session update did not rescan projects');

  const hidden = page.getByRole('button', {name: 'Remove project hidden-worker'});
  await hidden.waitFor({state: 'attached'});
  await page.waitForTimeout(1500);
  assert(await hidden.isDisabled(), 'a hidden live worker must refuse removal');
  console.log('Project with hidden live worker refused removal');
  const direct = await page.evaluate(async () => {
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const id = crypto.randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('forget timed out')), 10000);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id && message.requestId !== id) return;
        clearTimeout(timer);
        resolve(message.data ?? message.error);
      };
      socket.send(JSON.stringify({id, type:'REQ', sessionId:'global', method:'operation.invoke', data:{name:'neo.project.forget', input:{projectId:'hidden', removeHistory:true}}, timestamp:new Date().toISOString(), version:'1.0.0'}));
    });
    socket.close();
    return result;
  });
  assert.deepEqual(direct, {ok:false, reason:'project_in_use'});
  console.log('Backend also refused the hidden worker');

  const busy = page.getByRole('button', {name: 'Remove project occupied'});
  await busy.waitFor({state: 'attached'});
  assert(await busy.isDisabled(), 'a project with a chat must refuse removal');
  console.log('Project with chat refused removal');
  const refused = page.getByRole('button', {name: 'Remove project refused'});
  await refused.click({timeout: 15000});
  await page.getByRole('button', {name: 'Forget project'}).click();
  await page.getByText(/synthetic refusal/).waitFor({timeout: 15000});
  assert.equal(await page.getByRole('button', {name: 'New session in refused'}).count(), 1);
  console.log('Failed forget showed an error and retained the project');
  const history = await page.evaluate(async () => {
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const id = crypto.randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('history timed out')), 10000);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id && message.requestId !== id) return;
        clearTimeout(timer);
        resolve(message.data ?? message.error);
      };
      socket.send(JSON.stringify({id, type:'REQ', sessionId:'global', method:'workspace.history', data:{}, timestamp:new Date().toISOString(), version:'1.0.0'}));
    });
    socket.close();
    return result;
  });
  assert(history.entries.some((entry) => entry.path.endsWith('/projects/delta-only')));
  console.log('Failed forget preserved folder history');

  const count = await page.getByRole('button', { name: 'Remove project neo-read' }).count();
  console.log(`Remove control count: ${count}`);
  assert.equal(count, 1, 'empty system project must expose remove');
  const remove = page.getByRole('button', { name: 'Remove project neo-read' });
  await remove.waitFor({state: 'visible'});
  await remove.click({timeout: 15000});
  await page.getByText(/This forgets the project record and cannot be undone/).waitFor();
  await page.getByRole('button', {name: 'Forget project'}).click();
  await page.getByRole('button', {name: 'New session in neo-read'}).waitFor({state: 'detached', timeout: 15000});
  await page.reload();
  await page.getByRole('button', {name: 'New session in occupied'}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'New session in neo-read'}).count(), 0);
  assert.equal(await page.getByRole('button', {name: 'New session in alpha'}).count(), 0);
  assert(existsSync(`${run}/projects/alpha/retained.txt`));
  await page.getByText('Retained chat').waitFor();
  console.log('Forgotten project stayed gone; the file and unrelated chat remain');
} finally {
  await browser.close();
}
