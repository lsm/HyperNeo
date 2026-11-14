import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, spaceId] = process.argv.slice(2);
assert(port && run && spaceId && port !== '8399');
assert(process.env.PAIR_CODE, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const seen = {};
const settle = (page) => page.waitForTimeout(2000);
const pathOf = (page) => new URL(page.url()).pathname;

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Retired URL check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });

  const retired = [
    `/space/${spaceId}/sessions`,
    `/space/${spaceId}/tasks/archived`,
    `/space/${spaceId}/forge`,
    `/space/${spaceId}/configure/agents`,
    `/space/${spaceId}/configure/workflows`,
    `/space/${spaceId}/configure/settings`,
  ];
  for (const path of retired) {
    await page.goto(`${base}${path}`);
    await settle(page);
    seen[path] = { landedOn: pathOf(page) };
    assert.equal(
      seen[path].landedOn,
      '/spaces',
      `${path} no longer redirects to a canonical Space URL`
    );
  }

  await page.goto(`${base}/space/${spaceId}/evolve`);
  await settle(page);
  seen.evolve = { landedOn: pathOf(page), forgeView: await page.getByTestId('space-forge-view').count() };
  assert.equal(seen.evolve.forgeView, 1, 'the canonical /evolve URL still opens Forge');

  await page.goto(`${base}/space/${spaceId}/tasks/completed`);
  await settle(page);
  seen.completedTasks = {
    landedOn: pathOf(page),
    completedPressed: await page
      .getByRole('button', { name: /Completed/ })
      .first()
      .getAttribute('aria-pressed'),
  };
  assert.equal(
    seen.completedTasks.completedPressed,
    'true',
    'the canonical completed tab still renders from the route'
  );

  await page.goto(`${base}/space/${spaceId}/configure/workflow-templates`);
  await settle(page);
  seen.workflowTemplates = {
    landedOn: pathOf(page),
    tabBar: await page.locator('[data-testid="space-configure-tab-bar"]').count(),
  };
  assert.equal(
    seen.workflowTemplates.landedOn,
    `/space/${spaceId}/configure/workflow-templates`,
    'the canonical workflow-templates tab still resolves'
  );
  assert.equal(seen.workflowTemplates.tabBar, 1, 'the configure page still renders for that tab');

  seen.pageErrors = errors;
  writeFileSync(`${run}/evidence/retired-space-urls.json`, JSON.stringify(seen, null, 2));
  console.log(JSON.stringify(seen, null, 1));
} finally {
  await browser.close();
}
