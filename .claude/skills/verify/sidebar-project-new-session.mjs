import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
assert(process.env.PAIR_CODE, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const seen = {};
const opacity = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity);
const plus = (page, name) => page.getByRole('button', { name: `New session in ${name}` });

async function pairedContext(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Sidebar check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  return { context, storageState: await context.storageState() };
}

try {
  const { context: first, storageState } = await pairedContext({
    viewport: { width: 1280, height: 800 },
  });
  await first.close();

  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: scheme,
      storageState,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/sessions`);
    await plus(page, 'alpha').waitFor({ state: 'attached', timeout: 15000 });
    await page.mouse.move(900, 700);
    await page.waitForTimeout(400);
    const result = {
      hoverMedia: await page.evaluate(() => matchMedia('(hover: hover)').matches),
      restAlpha: await opacity(plus(page, 'alpha')),
      restBeta: await opacity(plus(page, 'beta')),
      addFolderButtons: await page.getByRole('button', { name: /Add folder/ }).count(),
    };
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-rest.png` });
    await page.getByTestId('project-group-header').filter({ hasText: 'alpha' }).hover();
    await page.waitForTimeout(400);
    result.hoverAlpha = await opacity(plus(page, 'alpha'));
    result.hoverBeta = await opacity(plus(page, 'beta'));
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-hover.png` });
    const remove = page.getByRole('button', { name: 'Remove project alpha' });
    const size = async (locator) => {
      const box = await locator.boundingBox();
      return `${Math.round(box.width)}x${Math.round(box.height)}`;
    };
    const background = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
    result.plusSize = await size(plus(page, 'alpha'));
    result.removeSize = await size(remove);
    result.plusRestBackground = await background(plus(page, 'alpha'));
    await plus(page, 'alpha').hover();
    await page.waitForTimeout(300);
    result.plusHoverBackground = await background(plus(page, 'alpha'));
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-hover-plus.png` });
    await remove.hover();
    await page.waitForTimeout(300);
    result.removeHoverBackground = await background(remove);
    result.removeIsTrash = await remove.locator('path[d="M3 6h18"]').count();
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-hover-remove.png` });
    await page.mouse.move(900, 700);
    await page.getByTestId('project-group-header').filter({ hasText: 'beta' }).focus();
    await page.waitForTimeout(400);
    result.focusBeta = await opacity(plus(page, 'beta'));
    result.focusAlpha = await opacity(plus(page, 'alpha'));
    await plus(page, 'alpha').click();
    const chip = page.locator('button:not([data-testid])[title$="/projects/alpha"]');
    await chip.waitFor({ timeout: 10000 });
    await page.mouse.move(900, 700);
    await page.waitForTimeout(800);
    result.pathAfterClick = new URL(page.url()).pathname;
    result.chipText = (await chip.textContent())?.trim();
    result.addProjectForms = await page.getByTestId('add-project-form').count();
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-new-session.png` });
    await chip.click();
    const addFolder = page.getByRole('menuitem', { name: 'Add folder to alpha…' });
    await addFolder.waitFor({ timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-folder-menu.png` });
    await addFolder.click();
    const folderInput = page.getByPlaceholder('Folder path');
    await folderInput.fill(`${run}/projects/assets-${scheme}`);
    await folderInput.press('Enter');
    await folderInput.waitFor({ state: 'detached', timeout: 10000 });
    await chip.click();
    const added = page.getByRole('menuitem', { name: `assets-${scheme}` });
    result.addedFolderInMenu = await added
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    result.addedFolderInSidebar = await page
      .locator(`div[title$="/projects/assets-${scheme}"]`)
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${run}/evidence/sidebar-${scheme}-folder-added.png` });
    await page.keyboard.press('Escape');
    result.pageErrors = errors;
    seen[scheme] = result;
    assert.equal(result.hoverMedia, true);
    assert.equal(result.addFolderButtons, 0);
    assert.equal(result.restAlpha, '0');
    assert.equal(result.restBeta, '0');
    assert.equal(result.hoverAlpha, '1');
    assert.equal(result.hoverBeta, '0');
    assert.equal(result.focusBeta, '1');
    assert.equal(result.focusAlpha, '0');
    assert.equal(result.pathAfterClick, '/sessions');
    assert.match(result.chipText ?? '', /alpha/);
    assert.equal(result.addProjectForms, 0);
    assert.equal(result.addedFolderInMenu, true);
    assert.equal(result.addedFolderInSidebar, true);
    assert.equal(result.plusSize, result.removeSize);
    assert.notEqual(result.plusHoverBackground, result.plusRestBackground);
    assert.equal(result.removeHoverBackground, result.plusHoverBackground);
    assert.equal(result.removeIsTrash, 1);
    assert.deepEqual(result.pageErrors, []);
    await context.close();
  }

  const touch = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: true,
    storageState,
  });
  const touchPage = await touch.newPage();
  await touchPage.goto(`${base}/sessions`);
  await plus(touchPage, 'alpha').waitFor({ state: 'attached', timeout: 15000 });
  seen.touch = {
    hoverMedia: await touchPage.evaluate(() => matchMedia('(hover: hover)').matches),
    restAlpha: await opacity(plus(touchPage, 'alpha')),
  };
  await touchPage.screenshot({ path: `${run}/evidence/sidebar-touch-rest.png` });
  assert.equal(seen.touch.hoverMedia, false);
  assert.equal(seen.touch.restAlpha, '1');
  await touch.close();
  console.log('PASS');
} finally {
  writeFileSync(`${run}/evidence/sidebar-project-new-session.json`, JSON.stringify(seen, null, 2));
  console.log(JSON.stringify(seen, null, 1));
  await browser.close();
}
