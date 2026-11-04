import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { verifyOpenControls } from './neo-open-controls-web.mjs';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { phase, run, url, artifactId } = fixture;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const evidence = `${run}/evidence`;
const observed = [];

const scene = async (width, height, touch, drive) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, locale: 'en-US' });
  await context.addCookies([{ name: 'hyperneo_device', value: readFileSync(`${run}/data/local-rpc.credential`, 'utf8').trim(), url }]);
  const page = await context.newPage();
  try { await drive(page); } finally { await context.close(); }
};
const shot = (page, name) => page.screenshot({ path: `${evidence}/${phase}-${name}.png`, animations: 'disabled' });
const tabNames = page => page.getByRole('tab').allInnerTexts();
const opener = page => page.locator('[data-ask="open-local-worker"]:visible [data-ask-todo] button[aria-label^="Open "]');
const openWorker = async (page, touch = false) => {
  const work = page.getByRole('tab', { name: /^Your work/ });
  if (await work.count()) await work.click();
  else if (touch) await page.getByRole('button', { name: /^Your work/ }).tap();
  await opener(page).click();
  await page.locator('.neo-session-pane:visible').waitFor();
};
const preview = async page => {
  const work = page.getByRole('tab', { name: /^Your work/ });
  if (await work.count()) await work.click();
  await page.getByRole('button', { name: /^Open preview: Report/ }).first().click();
  await page.getByRole('heading', { name: 'Synthetic report' }).waitFor();
};

const before = async () => {
  await scene(1280, 900, false, async page => {
    await page.goto(url);
    await preview(page);
    await shot(page, 'desktop-preview');
    await openWorker(page);
    await shot(page, 'desktop-session');
    assert.equal(await page.locator('.artifact-preview-panel').isVisible(), false);
    observed.push({ width: 1280, tabs: await tabNames(page), previewPanelVisible: false });
  });
  await scene(390, 844, true, async page => {
    await page.goto(url);
    await openWorker(page, true);
    await shot(page, 'phone-session');
    observed.push({ width: 390, tabs: await tabNames(page) });
  });
  return { baselineReproduced: true };
};

const after = async () => {
  for (const [width, height] of [[1280, 900], [1600, 1000]])
    await scene(width, height, false, async page => {
      await page.goto(url);
      await page.locator('[data-ask="open-local-worker"]').first().waitFor();
      assert.deepEqual(await tabNames(page), []);
      await shot(page, `${width}-work-only`);

      await openWorker(page);
      const session = page.getByRole('tab', { name: /local.worker/i });
      await session.waitFor();
      let names = await tabNames(page);
      assert.match(names[0], /^Your work/);
      assert.equal(names.length, 2);
      assert.equal(await session.getAttribute('aria-selected'), 'true');
      await page.getByText('Opening chat').waitFor({ state: 'detached' });
      await shot(page, `${width}-session-tab`);

      await page.locator('.neo-session-pane textarea').fill('Draft kept across tabs');
      await page.getByRole('tab', { name: /^Your work/ }).click();
      assert(await opener(page).isVisible());
      await opener(page).click();
      assert.equal((await tabNames(page)).length, 2);
      assert.equal(await page.locator('.neo-session-pane textarea').inputValue(), 'Draft kept across tabs');

      await page.getByRole('button', { name: /^Close .*local.worker/i }).click();
      await page.getByRole('tab').first().waitFor({ state: 'detached' });
      assert.deepEqual(await tabNames(page), []);
      await shot(page, `${width}-closed`);

      await preview(page);
      await openWorker(page);
      names = await tabNames(page);
      assert.match(names[0], /^Your work/);
      assert.equal(names.length, 3);
      await shot(page, `${width}-session-and-preview`);
      await page.getByRole('tab', { name: 'Report' }).click();
      await page.getByRole('heading', { name: 'Synthetic report' }).waitFor();
      await page.getByRole('tab', { name: /local.worker/i }).click();
      await page.locator('.neo-session-pane:visible').waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      observed.push({ width, tabs: names });
    });

  await scene(390, 844, true, async page => {
    await page.goto(url);
    await openWorker(page, true);
    assert.deepEqual(await tabNames(page), []);
    await shot(page, 'phone-session');
    const box = await page.locator('.neo-session-pane').boundingBox();
    assert.equal(Math.round(box.width), 390);
    await page.getByRole('button', { name: 'Back to Neo', exact: true }).tap();
    await page.locator('.neo-session-pane').waitFor({ state: 'detached' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    observed.push({ width: 390, tabs: [], fullScreenSession: true });
  });

  await scene(1280, 900, false, async page => {
    await page.goto(url);
    await openWorker(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Back to Neo', exact: true }).waitFor();
    assert.deepEqual(await tabNames(page), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('tab', { name: /local.worker/i }).waitFor();
    observed.push({ resize: 'tab to overlay and back' });

    await page.getByRole('tab', { name: /^Your work/ }).click();
    await page.locator('[data-ask="open-second-worker"]:visible [data-ask-todo] button[aria-label^="Open "]').click();
    await page.getByRole('tab', { name: /second.worker/i }).waitFor();
    assert.equal((await tabNames(page)).length, 3);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.neo-session-pane').getByRole('heading', { name: /second.worker/i }).waitFor();
    assert.deepEqual(await tabNames(page), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('tab', { name: /second.worker/i }).waitFor();
    observed.push({ resize: 'selected session survives with two session tabs' });
  });

  for (const [width, height, touch] of [[1280, 900, false], [390, 844, true]])
    await scene(width, height, touch, async page => {
      observed.push(await verifyOpenControls(page, fixture, { theme: 'light', touch, evidence }));
    });
  return { passed: true };
};

try {
  const result = await (phase === 'before' ? before() : after());
  writeFileSync(`${evidence}/browser.json`, JSON.stringify({ phase, ...result, observed }, null, 2));
} finally {
  await browser.close();
}
console.log(JSON.stringify(observed));
