import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, out, run] = process.argv.slice(2);
const sessionId = process.env.VERIFY_SESSION;
const slug = process.env.VERIFY_SPACE;
assert(port && out && run && sessionId && slug, 'usage: bottom-nav.mjs <port> <evidence-dir> <run-dir>');
assert.notEqual(port, '8399');
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const pair = JSON.parse(
  execSync(
    `env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Bottom nav proof"}'`,
    { encoding: 'utf8' }
  )
).reply;
assert(pair.ok, JSON.stringify(pair));
const observations = [];
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: 'en-US',
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  await page.goto(`${base}/pair#${pair.code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  assert.equal(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    true,
    'phone proof needs a coarse pointer'
  );

  const measure = async (view, path) => {
    await page.goto(`${base}${path}`);
    await page.waitForTimeout(1500);
    const bar = page.locator('[data-testid="bottom-tab-bar"]');
    const record = { view, path, bottomTabs: await bar.count() };
    assert.equal(record.bottomTabs, 0, `${view}: no bottom tab bar on a phone`);
    const menu = page.getByRole('button', { name: 'Open navigation menu' });
    assert.equal(await menu.count(), 1, `${view}: header exposes the navigation menu`);
    const composer = page.locator('.chat-footer');
    if (await composer.count()) {
      const box = await composer.first().boundingBox();
      record.composerInsideViewport = !!box && box.y + box.height <= 845;
      assert(record.composerInsideViewport, `${view}: composer stays inside the viewport`);
    }
    await page.screenshot({ path: join(out, `phone-${view}.png`) });
    observations.push(record);
    return record;
  };

  await measure('chats', '/sessions');
  await measure('settings', '/settings');
  await measure('session', `/session/${sessionId}`);

  await page.goto(`${base}/sessions`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Open navigation menu' }).tap();
  await page.waitForTimeout(500);
  const chatsEntry = page.getByRole('tab', { name: 'Chats', exact: true });
  const settingsEntry = page.getByRole('button', { name: 'Settings', exact: true });
  await page.screenshot({ path: join(out, 'phone-chats-drawer.png') });
  assert((await chatsEntry.count()) >= 1, 'drawer reaches Chats');
  assert((await settingsEntry.count()) >= 1, 'drawer reaches Settings');
  await settingsEntry.first().tap();
  await page.waitForTimeout(900);
  assert.equal(new URL(page.url()).pathname, '/settings', 'drawer Settings opens /settings');
  await page.screenshot({ path: join(out, 'phone-settings-from-drawer.png') });

  await page.goto(`${base}/spaces/${slug}`);
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Open navigation menu' }).tap();
  await page.waitForTimeout(600);
  await page.locator('[aria-label="Switch spaces"] button', { hasText: 'Phone nav' }).first().tap();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Open navigation menu' }).tap();
  await page.waitForTimeout(600);
  const navItems = await page
    .locator('[aria-label="Space navigation"] button')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ''));
  await page.screenshot({ path: join(out, 'phone-space-drawer.png') });
  for (const label of ['Overview', 'Tasks', 'Agents']) {
    assert(
      navItems.some((text) => text.startsWith(label)),
      `space drawer reaches ${label}`
    );
  }
  await page.locator('[aria-label="Space navigation"] button', { hasText: 'Tasks' }).first().tap();
  await page.waitForTimeout(900);
  const tasksPath = new URL(page.url()).pathname;
  await page.screenshot({ path: join(out, 'phone-space-tasks.png') });
  assert(tasksPath.includes('/tasks'), 'space drawer Tasks opens the tasks view');
  observations.push({ view: 'space', navItems, tasksPath });
  writeFileSync(join(out, 'bottom-nav.json'), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify({ passed: true, observations }, null, 2));
} finally {
  await browser.close();
}
