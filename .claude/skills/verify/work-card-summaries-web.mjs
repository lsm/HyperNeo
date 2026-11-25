import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { queueSection } from './queue-ask.mjs';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observed = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 874 }, isMobile: width < 800, hasTouch: width < 800 });
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
          if (request.data.input?.askId === 'a-api') detailIds.add(request.requestId ?? request.id);
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
    const settle = () => page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    const readsOf = id => reads.filter(read => read.input?.askId === id).length;
    const waitFor = async (check, label) => {
      for (let attempt = 0; !check() && attempt < 200; attempt++) await page.waitForTimeout(25);
      assert(check(), label);
    };
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();

    const history = page.locator('[data-ask="a-history"]:visible');
    await history.getByText('Finished synthetic history').waitFor();
    await history.locator('[data-ask-status]').getByText('· 22 todos', { exact: true }).waitFor();
    assert.equal(readsOf('a-history'), 0, 'a summary card outside the queue reads nothing up front');
    assert.equal(await history.getByText('Full synthetic history report', { exact: true }).count(), 0);
    await history.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await settle();
    await page.screenshot({ path: `${run}/evidence/summary-${width}.png` });
    await history.getByRole('button', { name: /^All · 22$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Finished synthetic history', exact: true });
    await dialog.getByRole('button', { name: '2 done — show more', exact: true }).click();
    const keep = dialog.getByRole('button', { name: 'Show details: Keep history replies' });
    await keep.or(dialog.getByRole('button', { name: 'Hide details: Keep history replies' })).first().waitFor();
    if (await keep.count()) await keep.click();
    await dialog.getByText('Full synthetic history report', { exact: true }).waitFor();
    await dialog.getByText('Full synthetic history instructions', { exact: true }).waitFor();
    assert.equal(readsOf('a-history'), 1, 'opening All reads the full ask once');
    await dialog.getByRole('button', { name: 'Close modal', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.locator('[data-human-queue]:visible').waitFor();
    const section = await queueSection(page, 'a-api');
    assert(section, 'the open ask is in the queue');
    await section.getByText('Which synthetic option?').waitFor();
    if (width === 1280) {
      await waitFor(() => held.length > 0, 'the queue reads the ask it lists');
      assert.equal(await section.getByRole('button', { name: 'Ship', exact: true }).count(), 0, 'no answer before the full read');
      assert.equal(await section.locator('article[data-ask]').count(), 0, 'no full ask before the full read');
      const pending = readsOf('a-api');
      await page.getByRole('textbox', { name: 'Message Neo', exact: true }).fill('Synthetic unsent draft');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(readsOf('a-api'), pending, 'draft edits must not restart a pending read');
      mode = 'pass';
      for (const release of held.splice(0)) release();
    }
    await section.getByRole('button', { name: 'Ship', exact: true }).waitFor();
    const card = page.locator('[data-ask="a-api"]:visible');
    await card.getByText('Draft the iOS API client').waitFor();
    const show = card.getByRole('button', { name: 'Show details: Preserve quote replies' });
    if (await show.count()) await show.click();
    await card.getByText('Full synthetic worker report', { exact: true }).waitFor();
    await card.getByText('Full synthetic task instructions', { exact: true }).waitFor();
    await settle();
    await page.screenshot({ path: `${run}/evidence/detail-${width}.png` });
    if (width === 1280) {
      await card.getByRole('button', { name: 'Ship', exact: true }).click();
      await card.getByRole('button', { name: 'Ship', exact: true }).waitFor({ state: 'hidden' });
      mode = 'fail';
      await page.reload();
      await page.locator('[data-human-queue]:visible').waitFor();
      const failed = await queueSection(page, 'a-api');
      assert(failed, 'the ask stays in the queue for its unfinished step');
      await failed.getByRole('alert').first().waitFor();
      assert.equal(await failed.locator('article[data-ask]').count(), 0, 'no full ask from a failed read');
      const failedReads = readsOf('a-api');
      await page.getByRole('textbox', { name: 'Message Neo', exact: true }).fill('Another unsent draft');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(readsOf('a-api'), failedReads, 'draft edits must not retry a failed read');
      await settle();
      await page.screenshot({ path: `${run}/evidence/failed-read-${width}.png` });
      mode = 'pass';
      await failed.getByRole('button', { name: 'Retry', exact: true }).first().click();
      await waitFor(() => readsOf('a-api') > failedReads, 'Retry reads the ask again');
      await failed.getByRole('alert').waitFor({ state: 'detached' });
      await failed.locator('article[data-ask]').waitFor();
    }
    observed.push({ width, detailReads: reads.length, todoCount: 22, summaryOutsideQueue: true, questionAnswered: width === 1280, pendingFailedAndRetriedReads: width === 1280 });
    await page.close();
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify(observed, null, 2));
}
