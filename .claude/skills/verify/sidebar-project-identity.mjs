import { projectDelete } from './sidebar-project-menu.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [port, out, populated] = process.argv.slice(2);
assert(port && out && populated && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const origin = `http://127.0.0.1:${port}`;
  await page.goto(`${origin}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Sidebar check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${origin}/sessions`);
  const rows = page.getByTestId('project-group-header').filter({ hasText: 'fixture-repo' });
  await rows.nth(1).waitFor();
  const count = await rows.count();
  console.log(`Visible rows for three checkouts of two repositories: ${count}`);
  assert.equal(count, 2);
  const codeRows = page.getByTestId('project-group-header').filter({ hasText: 'code-fixture' });
  const codeCount = await codeRows.count();
  console.log(`Visible rows for two checkouts sharing Git history without a remote: ${codeCount}`);
  assert.equal(codeCount, 1);
  for (const row of await page.getByTestId('project-group-header').all()) {
    if ((await row.getAttribute('aria-expanded')) === 'true') await row.click();
  }
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.reload();
    await rows.nth(1).waitFor();
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, colorScheme);
    await page.mouse.move(500, 100);
    await page.screenshot({
      path: `${out}/sidebar-project-identity-${colorScheme}.png`,
      animations: 'disabled',
    });
  }
  await (await projectDelete(page, 'code-fixture')).click();
  await codeRows.waitFor({ state: 'detached' });
  await page.reload();
  await rows.nth(1).waitFor();
  console.log(`Visible rows for the removed project after reload: ${await codeRows.count()}`);
  assert.equal(await codeRows.count(), 0);

  await page.getByTestId('add-project-button').click();
  await page.getByTestId('add-project-path-input').fill(populated);
  await page.getByTestId('add-project-path-input').press('Enter');
  const expandedMembership = page.locator(
    '[data-testid="project-group-header"][title*="/primary/"][title*="/populated/"]'
  );
  await expandedMembership.waitFor();
  const expanded = await expandedMembership.getAttribute('aria-expanded');
  console.log(`Grouped project expanded after adding a checkout with commits: ${expanded}`);
  assert.equal(expanded, 'false');

  await page.routeWebSocket('**/ws', (route) => {
    const server = route.connectToServer();
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === 'workspace.history' && request.data?.includeRepositoryProjects) return;
      server.send(raw);
    });
  });
  await page.reload();
  await rows.nth(3).waitFor();
  console.log(`Visible saved rows after the grouped history request times out: ${await rows.count()}`);
  assert.equal(await rows.count(), 4);
} finally {
  await browser.close();
}
