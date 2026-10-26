import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observed = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 874 } });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const reads = [];
    const detailIds = new Set();
    const held = [];
    let mode = width === 1280 ? 'hold' : 'pass';
    await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const request = JSON.parse(String(raw));
        if (request.data?.name === 'neo.ask.read') {
          reads.push(request.data);
          detailIds.add(request.requestId ?? request.id);
        }
        server.send(raw);
      });
      server.onMessage(raw => {
        const response = JSON.parse(String(raw));
        if (detailIds.has(response.requestId ?? response.id)) {
          if (mode === 'hold') { held.push(() => socket.send(raw)); return; }
          if (mode === 'fail') {
            socket.send(JSON.stringify({ ...response, data: { ok: false, reason: 'Synthetic full card unavailable' } }));
            return;
          }
        }
        socket.send(raw);
      });
    });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
    const card = page.locator('[data-ask="a-api"]:visible');
    await card.getByText('Draft the iOS API client').waitFor();
    await card.getByText('Todos · 22 · Waiting on you · 1', { exact: true }).waitFor();
    await card.getByRole('button', { name: '21 done — show more', exact: true }).waitFor();
    assert.equal(await card.getByText('Which synthetic option?').count(), 0);
    assert.equal(reads.length, 0);
    assert.equal(await card.getByText('Full synthetic worker report', { exact: true }).count(), 0);
    await page.screenshot({ path: `${run}/evidence/summary-${width}.png` });
    await card.getByRole('button', { name: 'Show details: Preserve quote replies' }).click();
    if (width === 1280) {
      for (let attempt = 0; held.length === 0 && attempt < 100; attempt++) await page.waitForTimeout(25);
      assert.equal(held.length, 1, 'one pending detail reply');
      await page.getByRole('textbox', { name: 'Message Neo', exact: true }).fill('Synthetic unsent draft');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(reads.length, 1, 'draft edits must not restart a pending read');
      mode = 'pass';
      for (const release of held.splice(0)) release();
    }
    await card.getByText('Full synthetic worker report', { exact: true }).waitFor();
    await card.getByText('Full synthetic task instructions', { exact: true }).waitFor();
    assert.equal(reads.length, 1);
    await page.screenshot({ path: `${run}/evidence/detail-${width}.png` });
    await card.getByRole('button', { name: 'A Ship', exact: true }).waitFor();
    if (width === 1280) {
      await card.getByRole('button', { name: 'A Ship', exact: true }).click();
      await card.getByRole('button', { name: 'A Ship', exact: true }).waitFor({ state: 'hidden' });
      mode = 'fail';
      await page.reload();
      await card.getByRole('button', { name: 'Show details: Preserve quote replies' }).click();
      await card.getByText('Synthetic full card unavailable', { exact: true }).waitFor();
      const failedReads = reads.length;
      await page.getByRole('textbox', { name: 'Message Neo', exact: true }).fill('Another unsent draft');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(reads.length, failedReads, 'draft edits must not retry a failed read');
      await page.screenshot({ path: `${run}/evidence/failed-read-${width}.png` });
    }
    observed.push({ width, detailReads: reads.length, todoCount: 22, questionAnswered: width === 1280, pendingAndFailedReadsStable: width === 1280 });
    await page.close();
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify(observed, null, 2));
}
