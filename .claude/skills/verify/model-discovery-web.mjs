import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const [port, run] = process.argv.slice(2);
assert(Number(port) > 0 && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const evidence = { calls: [], errors: [], preferenceWrites: [] };
const sent = new Map();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page.setDefaultTimeout(80000);
  page.on('websocket', socket => {
    socket.on('framesent', event => {
      try {
        const message = JSON.parse(String(event.payload));
        if (message.type === 'REQ' && (message.method === 'settings.global.update' || (message.method === 'operation.invoke' && message.data?.name === 'neo.preferences.set'))) evidence.preferenceWrites.push(message.method);
        if (message.type === 'REQ' && message.method === 'models.list') sent.set(message.id, { start: Date.now(), forceRefresh: message.data?.forceRefresh === true });
      } catch {}
    });
    socket.on('framereceived', event => {
      try {
        const message = JSON.parse(String(event.payload));
        const request = sent.get(message.requestId);
        if (!request) return;
        sent.delete(message.requestId);
        evidence.calls.push({ forceRefresh: request.forceRefresh, elapsedMs: Date.now() - request.start, error: message.error ?? null, modelIds: message.data?.models?.map(model => model.id) });
      } catch {}
    });
  });
  page.on('pageerror', error => evidence.errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/settings?tab=models`);
  const refresh = page.getByRole('button', { name: 'Refresh models', exact: true });
  await refresh.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh models' && !button.disabled));
  assert.equal(await page.getByRole('alert').count(), 0);
  await refresh.click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh models' && !button.disabled));
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByText('Cold model', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${run}/evidence/model-discovery-browser.png`, animations: 'disabled' });
  assert(evidence.calls.some(call => !call.forceRefresh && call.elapsedMs > 10000 && call.modelIds?.includes('cold-model')), 'cold browser load exceeded old 10s budget and returned its model');
  assert(evidence.calls.some(call => call.forceRefresh && call.elapsedMs > 30000 && call.modelIds?.includes('cold-model')), 'forced browser refresh survived joining the prior discovery pass');
  await page.goto(`http://127.0.0.1:${port}/settings?tab=neo-model`);
  await page.getByRole('region', { name: 'Neo models', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh models' && !button.disabled));
  const priorCalls = evidence.calls.length;
  await refresh.click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh models' && !button.disabled));
  assert.equal(await page.getByRole('alert').count(), 0);
  assert(evidence.calls.slice(priorCalls).some(call => call.forceRefresh && call.modelIds?.includes('cold-model')), 'Neo Settings refresh returned the discovered model');
  assert.deepEqual(evidence.preferenceWrites, []);
  evidence.neoRefreshWithoutPreferenceWrite = true;
  await page.screenshot({ path: `${run}/evidence/model-discovery-neo-browser.png`, animations: 'disabled' });
  assert(evidence.calls.every(call => !call.error));
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
} catch (error) { evidence.failure = String(error); throw error; }
finally {
  writeFileSync(`${run}/evidence/model-discovery-browser.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
