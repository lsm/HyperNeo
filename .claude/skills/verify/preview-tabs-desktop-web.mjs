import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, port = '9395', phase = 'after'] = process.argv.slice(2);
const run = realpathSync(directory);
assert.notEqual(port, '8399');
const verify = fileURLToPath(new URL('.', import.meta.url));
const code = execFileSync(
  'bun',
  [join(verify, 'rpc.ts'), 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic desktop preview' })],
  { encoding: 'utf8', env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') } }
).match(/"code":\s*"([^"]+)"/)?.[1];
assert(code, 'no pairing code');
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const observed = {};
try {
  const pairing = await browser.newContext();
  const paired = await pairing.request.post(`${base}/pair`, {
    headers: { origin: base },
    data: { code, name: 'Synthetic desktop preview' },
  });
  assert.equal(paired.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await browser.newContext({ storageState, viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort()
  );
  await context.addInitScript(() => {
    window.isTauri = true;
  });
  const page = await context.newPage();
  await page.goto(`${base}/neo`);
  await page.getByRole('button', { name: /^In progress \d/ }).click();
  const open = page.getByRole('button', { name: /^Open .*Report/ }).first();
  await open.waitFor({ timeout: 15000 }).catch(async (error) => {
    await page.screenshot({ path: join(run, 'evidence', `${phase}-no-work.png`) });
    throw error;
  });
  await page.waitForTimeout(500);
  observed.backToChat = await page.getByRole('button', { name: 'Back to chat' }).count();
  await page.screenshot({ path: join(run, 'evidence', `${phase}-closed.png`) });
  await open.click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('tab', { name: /^Your work/ }).waitFor();
  await page.waitForTimeout(800);
  observed.hits = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] [role="tab"], [role="dialog"] button')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          name: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 40),
          top: Math.round(box.top),
          receives: !!hit && (hit === element || element.contains(hit)),
          coveredBy: hit && !(hit === element || element.contains(hit)) ? hit.className || hit.tagName : null,
        };
      })
  );
  await page.screenshot({ path: join(run, 'evidence', `${phase}-open.png`) });
  const work = page.getByRole('tab', { name: /^Your work/ });
  const box = await work.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  observed.workSelectedAfterClick = await work.getAttribute('aria-selected');
  await page.screenshot({ path: join(run, 'evidence', `${phase}-work-clicked.png`) });
  await context.close();
} finally {
  await browser.close();
  writeFileSync(join(run, 'evidence', 'preview-tabs-desktop.json'), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed, null, 2));
assert(observed.hits.length > 0, 'no preview controls found');
assert.deepEqual(observed.hits.filter((hit) => !hit.receives), [], 'preview controls are covered');
assert.equal(observed.workSelectedAfterClick, 'true');
console.log('PASS: every preview tab and button receives its click in the desktop app layout');
