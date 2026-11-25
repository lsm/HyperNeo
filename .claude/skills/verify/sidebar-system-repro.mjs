import { projectActions, projectDelete } from './sidebar-project-menu.mjs';
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
  const scheme = process.env.VERIFY_COLOR_SCHEME || 'light';
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
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
  let injectTemporaryFailure = Boolean(process.env.VERIFY_INJECT_FAILURE);
  await page.routeWebSocket('**/ws', (route) => {
    const server = route.connectToServer();
    const failures = new Map();
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const { name, input } = message.data ?? {};
      if (message.method === 'operation.invoke' && name === 'work.find' && input?.folder?.endsWith('/projects/alpha')) {
        if (!input.localOnly) failures.set(message.id, 'offline-peer');
        else if (injectTemporaryFailure) {
          failures.set(message.id, 'local-adapter');
          injectTemporaryFailure = false;
        }
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const id = message.requestId ?? message.id;
      const source = failures.get(id);
      if (source && message.data) {
        message.data.unreachable.push({source, reason:'synthetic outage'});
        failures.delete(id);
        route.send(JSON.stringify(message));
      } else {
        route.send(raw);
      }
    });
  });
  await page.goto(`http://127.0.0.1:${port}/sessions`);
  await page.getByRole('button', { name: 'New session in neo-read' }).waitFor({ state: 'attached' });
  for (const name of ['Shared project', 'Stale project']) {
    const header = page.getByTestId('project-group-header').filter({hasText:name});
    if (await header.getAttribute('aria-expanded') === 'true') await header.click();
  }
  await page.getByTestId('project-group-header').filter({ hasText: 'neo-read' }).hover();
  if (process.env.VERIFY_INJECT_FAILURE) {
    const retry = await projectDelete(page, 'neo-read');
    await page.waitForFunction(() => document.querySelector('[role="menuitem"]:last-child')?.title === 'Could not check project work', null, {timeout:15000});
    assert(await retry.isDisabled());
    await page.evaluate(async (folder) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const id = crypto.randomUUID();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session creation timed out')), 10000);
        socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id !== id && message.requestId !== id) return; clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.data); };
        socket.send(JSON.stringify({id,type:'REQ',sessionId:'global',method:'session.create',data:{title:'Connectivity update',workspacePath:folder,config:{queryMode:'manual'}},timestamp:new Date().toISOString(),version:'1.0.0'}));
      });
      socket.close();
    }, `${run}/projects/beta`);
    await page.getByText('Connectivity update').waitFor({timeout:15000});
    console.log('Observed temporary work lookup failure');
  }
  const ended = await projectDelete(page, 'neo-read');
  await page.waitForFunction(() => {
    const button = document.querySelector('[role="menuitem"]:last-child');
    return button && button.title !== 'Checking project work';
  }, null, { timeout: 15000 });
  if (process.env.VERIFY_INJECT_FAILURE) {
    await page.waitForFunction(() => !document.querySelector('[role="menuitem"]:last-child')?.disabled, null, {timeout: 15000});
  }
  assert.equal(await page.getByText('Finished synthetic worker').count(), 0);
  await page.screenshot({ path: `${run}/evidence/sidebar-ended-worker.png` });
  assert.equal(await ended.isEnabled(), true, `a finished hidden worker blocked removal: ${await ended.getAttribute('title')}`);
  console.log('A finished hidden worker and an offline peer did not block removal');
  if (process.env.VERIFY_INJECT_FAILURE) console.log('Work lookup recovered after the project list refreshed');
  await page.screenshot({ path: `${run}/evidence/sidebar-system-hover.png` });
  const inbox = await projectDelete(page, 'Inbox');
  await inbox.waitFor({state:'attached'});
  assert(await inbox.isDisabled(), 'the protected Inbox must refuse removal');
  assert.equal(await inbox.getAttribute('title'), 'This project cannot be forgotten.');
  await page.getByTestId('project-group-header').filter({hasText:'occupied'}).hover();
  await page.getByRole('tooltip').filter({hasText:'Project has chats'}).waitFor({state:'visible', timeout:3000});
  await page.screenshot({path:`${run}/evidence/sidebar-${scheme}-refusal.png`, animations:'disabled'});
  console.log('Protected Inbox cannot be forgotten');
  async function callRpc(method, data) {
    return page.evaluate(async ({method, data}) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const id = crypto.randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RPC timed out')), 10000);
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== id && message.requestId !== id) return;
          clearTimeout(timer);
          if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.data);
        };
        socket.send(JSON.stringify({id,type:'REQ',sessionId:'global',method,data,timestamp:new Date().toISOString(),version:'1.0.0'}));
      });
      socket.close();
      return result;
    }, {method, data});
  }
  const shared = await projectDelete(page, 'Shared project');
  await shared.click();
  await projectActions(page, 'Shared project').waitFor({state:'detached'});
  let historyResult = await callRpc('workspace.history', {});
  assert(!historyResult.entries.some((entry) => entry.path.endsWith('/projects/shared-a') || entry.path.endsWith('/projects/shared-b')));
  assert(existsSync(`${run}/projects/shared-a/retained.txt`));
  console.log('Both shared folders disappeared and the file remained');
  const stale = await projectDelete(page, 'Stale project');
  await stale.waitFor({state:'attached'});
  assert.deepEqual(await callRpc('workspace.remove', {path:`${run}/projects/stale-a`}), {success:true});
  await stale.click();
  await page.getByText('Failed to remove project').waitFor();
  await page.getByRole('button', {name:'Dismiss notification'}).first().click();
  await page.getByRole('alert').filter({hasText:'Failed to remove project'}).waitFor({state:'detached'});
  historyResult = await callRpc('workspace.history', {});
  const remaining = historyResult.entries.find((entry) => entry.path.endsWith('/projects/stale-b'));
  assert(remaining && remaining.project.folders.length === 1 && remaining.project.folders[0].endsWith('/projects/stale-b'));
  assert.deepEqual(await callRpc('workspace.remove', {path:`${run}/projects/stale-a`}), {success:false});
  console.log('Missing folder produced an error; remaining membership was intact');
  const archived = await projectDelete(page, 'archived-chat');
  await archived.click({timeout:15000});
  await page.getByRole('button', {name:'Forget project'}).click();
  await projectActions(page, 'archived-chat').waitFor({state:'detached'});
  const archivedSessions = await callRpc('session.list', {includeArchived:true});
  assert(archivedSessions.sessions.some(({id, status}) => id === 'archived-chat' && status === 'archived'));
  console.log('Archived-only project was forgotten and its chat stayed archived');
  const linked = await projectDelete(page, 'linked-ask');
  await linked.click({timeout:15000});
  await page.getByRole('button', {name: 'Forget project'}).click();
  await page.getByText('Project has chats, workers, or other linked work.').waitFor({timeout:15000});
  await page.screenshot({path:`${run}/evidence/sidebar-${scheme}-error.png`, animations:'disabled'});
  await page.getByRole('button', {name:'Dismiss notification'}).first().click();
  await page.getByRole('alert').filter({hasText:'Project has chats, workers, or other linked work.'}).waitFor({state:'detached'});
  assert.equal(await projectActions(page, 'linked-ask').count(), 1);
  console.log('Linked work refusal was explained');
  const remote = await projectDelete(page, 'remote-work');
  await remote.waitFor({state: 'attached'});
  assert(await remote.isDisabled());
  assert.equal(await remote.getAttribute('title'), 'Cannot check all work for this project');
  const folderless = await projectDelete(page, 'folderless');
  await folderless.click({timeout: 15000});
  await page.getByRole('button', {name: 'Forget project'}).click();
  await projectActions(page, 'folderless').waitFor({state:'detached', timeout:15000});
  console.log('Forgot a folderless project; remote work remains protected');
  await projectDelete(page, 'refused');
  await page.waitForFunction(() => !document.querySelector('[role="menuitem"]:last-child')?.disabled, null, {timeout:15000});
  await page.keyboard.press('Escape');
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

  const hidden = await projectDelete(page, 'hidden-worker');
  await hidden.waitFor({state: 'attached'});
  await page.waitForTimeout(1500);
  assert(await hidden.isDisabled(), 'a hidden live worker must refuse removal');
  assert.equal(await hidden.getAttribute('title'), 'Project has active work');
  await page.getByTestId('project-group-header').filter({hasText:'hidden-worker'}).hover();
  await page.getByRole('tooltip').filter({hasText:'Project has active work'}).waitFor({state:'visible', timeout:3000});
  await page.screenshot({path:`${run}/evidence/sidebar-${scheme}-active-work.png`, animations:'disabled'});
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

  const busy = await projectDelete(page, 'occupied');
  await busy.waitFor({state: 'attached'});
  assert(await busy.isDisabled(), 'a project with a chat must refuse removal');
  console.log('Project with chat refused removal');
  const refused = await projectDelete(page, 'refused');
  await refused.click({timeout: 15000});
  await page.getByRole('button', {name: 'Forget project'}).click();
  await page.getByText(/synthetic refusal/).waitFor({timeout: 15000});
  await page.getByRole('button', {name:'Dismiss notification'}).first().click();
  await page.getByRole('alert').filter({hasText:'synthetic refusal'}).waitFor({state:'detached'});
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

  const count = await projectActions(page, 'neo-read').count();
  console.log(`Remove control count: ${count}`);
  assert.equal(count, 1, 'empty system project must expose remove');
  const remove = await projectDelete(page, 'neo-read');
  await remove.waitFor({state: 'visible'});
  await remove.click({timeout: 15000});
  await page.getByText('Your files and chats stay. The folder leaves the sidebar, and this project is permanently forgotten.').waitFor();
  await page.screenshot({path:`${run}/evidence/sidebar-${scheme}-confirm.png`, animations:'disabled'});
  await page.getByRole('button', {name: 'Forget project'}).click();
  await page.getByRole('button', {name: 'New session in neo-read'}).waitFor({state: 'detached', timeout: 15000});
  await page.reload();
  await page.getByRole('button', {name: 'New session in occupied'}).waitFor();
  assert.equal(await page.getByRole('button', {name: 'New session in neo-read'}).count(), 0);
  assert.equal(await page.getByRole('button', {name: 'New session in alpha'}).count(), 0);
  assert.equal(await projectActions(page, 'archived-chat').count(), 0);
  assert(existsSync(`${run}/projects/alpha/retained.txt`));
  await page.getByText('Retained chat').waitFor();
  const { session: finished } = await callRpc('session.get', {sessionId:'ended-worker'});
  assert.equal(finished.status, 'ended');
  assert.equal(finished.context?.spaceId, 'space:sidebar-fixture');
  await page.screenshot({path:`${run}/evidence/sidebar-${scheme}-after.png`, animations:'disabled'});
  console.log('Forgotten project stayed gone; the finished worker, file and unrelated chat remain');
} finally {
  await browser.close();
}
