import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observed = [];
try {
  for (const width of [402, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 874 } });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const reads = [];
    page.on('websocket', socket => socket.on('framesent', frame => {
      const request = JSON.parse(String(frame.payload));
      if (request.data?.name === 'neo.ask.read') reads.push(request.data);
    }));
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
    const card = page.locator('[data-ask="a-api"]:visible');
    await card.getByText('Draft the iOS API client').waitFor();
    assert.equal(await card.getByText('Which synthetic option?').count(), 0);
    assert.equal(reads.length, 0);
    assert.equal(await card.getByText('Full synthetic worker report', { exact: true }).count(), 0);
    await page.screenshot({ path: `${run}/evidence/summary-${width}.png` });
    await card.getByRole('button', { name: 'Show details: Preserve quote replies' }).click();
    await card.getByText('Full synthetic worker report', { exact: true }).waitFor();
    await card.getByText('Full synthetic task instructions', { exact: true }).waitFor();
    assert.equal(reads.length, 1);
    await page.screenshot({ path: `${run}/evidence/detail-${width}.png` });
    await card.getByRole('button', { name: 'Ship', exact: true }).click();
    await card.getByRole('button', { name: 'Ship', exact: true }).waitFor({ state: 'hidden' });
    observed.push({ width, detailReads: reads.length, questionAnswered: true });
    await page.close();
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify(observed, null, 2));
}
