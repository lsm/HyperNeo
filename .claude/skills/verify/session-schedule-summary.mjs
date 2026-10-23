import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const surface = JSON.parse(readFileSync(`${run}/evidence/schedule-web-seed.json`, 'utf8')).find(item => item.name === 'session');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless:true,
  ...(process.env.VERIFY_BROWSER ? { executablePath:process.env.VERIFY_BROWSER } : {}),
});
try {
  const page = await browser.newPage({ viewport:{ width:390, height:1000 }, locale:'en-US' });
  let block = true;
  let capture;
  const held = new Promise(resolve => { capture = resolve; });
  await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (block && message.data?.name === 'schedule.session.list') capture({ socket, message });
      else server.send(raw);
    });
  });
  await page.goto(`http://127.0.0.1:${port}/session/${surface.sessionId}`);
  let timeout;
  const pending = await Promise.race([held,new Promise((_resolve,reject) => {
    timeout = setTimeout(() => reject(new Error('No schedule list request')),10000);
  })]).finally(() => clearTimeout(timeout));
  const strip = page.locator(`[data-session-schedules="${surface.sessionId}"]`);
  await strip.waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
  const summary = strip.locator('summary');
  const loading = (await summary.innerText()).trim();
  assert.equal(await strip.getAttribute('open'),null);
  await page.screenshot({ path:`${run}/evidence/schedule-summary-loading.png`, fullPage:true });
  pending.socket.send(JSON.stringify({ id:crypto.randomUUID(), type:'RSP',
    requestId:pending.message.id, sessionId:pending.message.sessionId, method:pending.message.method,
    data:{ ok:false, reason:'Synthetic schedule read unavailable' }, timestamp:new Date().toISOString(), version:'1.0.0',
  }));
  await strip.getByText('Synthetic schedule read unavailable').waitFor({ state:'attached' });
  const failed = (await summary.innerText()).trim();
  await page.screenshot({ path:`${run}/evidence/schedule-summary-failed.png`, fullPage:true });
  block = false;
  await summary.click();
  await strip.getByRole('button',{ name:'Refresh schedules', exact:true }).click();
  await strip.locator(`[data-schedule="${surface.scheduleId}"]`).waitFor();
  await page.waitForFunction(id => !document.querySelector(`[data-session-schedules="${id}"] > div > button`)?.disabled, surface.sessionId);
  await summary.click();
  const recovered = (await summary.innerText()).trim();
  await page.screenshot({ path:`${run}/evidence/schedule-summary-recovered.png`, fullPage:true });
  writeFileSync(`${run}/evidence/schedule-summary.json`,JSON.stringify({ loading,failed,recovered,injection:'Only the first list reply was held/refused; retry and other RPCs use the real daemon.' },null,2));
  assert.equal(loading,'Schedules');
  assert.equal(failed,'Schedules');
  assert.equal(recovered,'Schedules · 2');
  console.log(`PASS: unknown loading/failed count and real successful retry count. ${run}/evidence/schedule-summary.json`);
} finally { await browser.close(); }
