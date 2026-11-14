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
const retargetFolders = [];
const retargetOwners = {};
const opacity = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity);
const plus = (page, name) => page.getByRole('button', { name: `New session in ${name}` });
const ownerKey = (value) => value.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
const chipFor = (page, path) =>
  page.locator(`button:not([data-testid]):not([role="menuitem"])[title$="${path}"]`);

async function projectOwners() {
  const credential = process.env.VERIFY_CREDENTIAL;
  if (!credential) throw new Error('VERIFY_CREDENTIAL is required for the history check');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const id = crypto.randomUUID();
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('workspace.history timed out')), 30_000);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId !== id && message.id !== id) return;
      clearTimeout(timer);
      resolve(message.error ? { error: message.error } : message.data);
    };
    socket.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method: 'workspace.history',
        data: {},
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
  socket.close();
  if (!reply || reply.error) throw new Error(`workspace.history failed: ${JSON.stringify(reply)}`);
  return Object.fromEntries(
    (reply?.entries ?? [])
      .filter((entry) => entry.project)
      .map((entry) => [ownerKey(entry.path), entry.project.name])
  );
}

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
    const chip = page.locator(
      'button:not([data-testid]):not([role="menuitem"])[title$="/projects/alpha"]'
    );
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
    await page.getByRole('menuitem', { name: `assets-${scheme}` }).click();
    await page.waitForTimeout(400);
    await chipFor(page, `/projects/assets-${scheme}`).click();
    result.secondaryFolderMenu = await page
      .getByRole('menuitem', { name: 'Add folder to alpha…' })
      .count();
    result.secondaryFolderOwnName = await page
      .getByRole('menuitem', { name: `Add folder to assets-${scheme}…` })
      .count();
    await page.keyboard.press('Escape');
    await page.mouse.move(900, 700);
    await plus(page, 'alpha').hover();
    await plus(page, 'alpha').click();
    await chip.waitFor({ timeout: 10000 });
    await chip.click();
    await page.getByRole('menuitem', { name: 'Add folder to alpha…' }).click();
    const retargetInput = page.getByPlaceholder('Folder path');
    await retargetInput.waitFor({ timeout: 5000 });
    await plus(page, 'beta').hover();
    await plus(page, 'beta').click();
    await page.waitForTimeout(600);
    result.retargetFormOpen = await retargetInput.count();
    result.retargetHint = await page.getByText(/Adds a folder to alpha/).count();
    const retargetPath = `${run}/projects/assets-${scheme}-retarget`;
    await retargetInput.fill(retargetPath);
    await retargetInput.press('Enter');
    const retargetClosed = await retargetInput
      .waitFor({ state: 'detached', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!retargetClosed) {
      const reason = await page
        .locator('p.text-danger')
        .first()
        .textContent()
        .catch(() => null);
      throw new Error(
        `the form did not close after adding ${retargetPath} (${scheme}): ${reason ?? 'no reason shown'}`
      );
    }
    retargetFolders.push(retargetPath);
    const retargetOwner = (await projectOwners())[ownerKey(retargetPath)];
    retargetOwners[ownerKey(retargetPath)] = retargetOwner;
    if (retargetOwner !== 'alpha')
      throw new Error(
        `${retargetPath} belongs to ${retargetOwner ?? 'no project'} after the sidebar switched to beta`
      );
    await page.keyboard.press('Escape');
    await page.mouse.move(900, 700);
    await plus(page, 'alpha').hover();
    await plus(page, 'alpha').click();
    await chip.waitFor({ timeout: 10000 });
    await page.getByTestId('add-project-button').click();
    await page.getByTestId('add-project-path-input').fill(`${run}/projects/gamma-${scheme}`);
    await page.getByTestId('add-project-path-input').press('Enter');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.mouse.move(900, 700);
    await chip.click();
    const gammaItem = page.getByRole('menuitem', { name: `gamma-${scheme}` });
    result.newProjectInPageMenu = await gammaItem
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await gammaItem.click();
    await page.waitForTimeout(600);
    await chipFor(page, `/projects/gamma-${scheme}`).click();
    await page.getByRole('menuitem', { name: `Add folder to gamma-${scheme}…` }).click();
    const staleInput = page.getByPlaceholder('Folder path');
    await staleInput.waitFor({ timeout: 5000 });
    await page.getByTestId('project-group-header').filter({ hasText: `gamma-${scheme}` }).hover();
    await page.getByRole('button', { name: `Remove project gamma-${scheme}` }).click();
    await page.waitForTimeout(800);
    result.staleFormOpen = await staleInput.count();
    await staleInput.fill(`${run}/projects/gamma-${scheme}-assets`);
    await staleInput.press('Enter');
    await page.waitForTimeout(1000);
    result.staleFormRefused = await page.getByText(/is no longer a project/).count();
    result.staleFormStillOpen = await staleInput.count();
    await page.keyboard.press('Escape');
    await page.mouse.move(900, 700);
    await plus(page, 'alpha').hover();
    await plus(page, 'alpha').click();
    await chip.waitFor({ timeout: 10000 });
    await chip.click();
    result.staleProjectRecreated = await page
      .getByRole('menuitem', { name: `gamma-${scheme}`, exact: true })
      .count();
    await page.keyboard.press('Escape');
    await page.mouse.move(900, 700);
    await plus(page, 'alpha').hover();
    await plus(page, 'alpha').click();
    await chip.waitFor({ timeout: 10000 });
    await page.getByTestId('add-project-button').click();
    await page.getByTestId('add-project-path-input').fill(`${run}/projects/delta-${scheme}`);
    await page.getByTestId('add-project-path-input').press('Enter');
    await page.waitForTimeout(1000);
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
    assert.equal(result.retargetFormOpen, 1);
    assert.equal(result.retargetHint, 1);
    assert.equal(result.secondaryFolderMenu, 1);
    assert.equal(result.secondaryFolderOwnName, 0);
    assert.equal(result.newProjectInPageMenu, true);
    assert.equal(result.staleFormOpen, 1);
    assert.equal(result.staleFormRefused, 1);
    assert.equal(result.staleFormStillOpen, 1);
    assert.equal(result.staleProjectRecreated, 0);
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
  const only = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState,
  });
  const onlyPage = await only.newPage();
  const onlyErrors = [];
  onlyPage.on('pageerror', (error) => onlyErrors.push(error.message));
  await onlyPage.goto(`${base}/sessions`);
  await plus(onlyPage, `delta-only`).waitFor({ state: 'attached', timeout: 15000 });
  await onlyPage.mouse.move(900, 700);
  await plus(onlyPage, 'delta-only').hover();
  await plus(onlyPage, 'delta-only').click();
  const onlyChip = chipFor(onlyPage, `/projects/delta-only`);
  await onlyChip.waitFor({ timeout: 10000 });
  await onlyChip.click();
  await onlyPage.getByRole('menuitem', { name: 'Add folder to delta-only…' }).click();
  const onlyInput = onlyPage.getByPlaceholder('Folder path');
  await onlyInput.waitFor({ timeout: 5000 });
  const headers = onlyPage.getByTestId('project-group-header');
  while ((await headers.count()) > 0) {
    const first = headers.first();
    const name = ((await first.textContent()) ?? '').trim();
    await first.hover();
    await onlyPage.getByRole('button', { name: `Remove project ${name}` }).click();
    await onlyPage.waitForTimeout(700);
  }
  seen.only = { formOpen: await onlyInput.count() };
  await onlyInput.fill(`${run}/projects/delta-only-assets`);
  await onlyInput.press('Enter');
  await onlyPage.waitForTimeout(1000);
  seen.only.refused = await onlyPage.getByText(/is no longer a project/).count();
  assert.equal(seen.only.formOpen, 1);
  assert.equal(seen.only.refused, 1);
  seen.only.pageErrors = onlyErrors;
  assert.deepEqual(seen.only.pageErrors, []);
  await only.close();

  writeFileSync(
    `${run}/evidence/retarget-project.txt`,
    Object.entries(retargetOwners)
      .map(([path, name]) => `${path} -> project ${name}`)
      .join('\n') + '\n'
  );
  console.log('PASS');
} finally {
  writeFileSync(
    `${run}/evidence/sidebar-project-new-session.json`,
    JSON.stringify({ ...seen, retargetFolders, retargetOwners }, null, 2)
  );
  console.log(JSON.stringify(seen, null, 1));
  await browser.close();
}
