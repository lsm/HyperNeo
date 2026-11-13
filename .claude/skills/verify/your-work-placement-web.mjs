import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, port = '9394'] = process.argv.slice(2);
const run = realpathSync(directory);
assert.notEqual(port, '8399');
const verify = fileURLToPath(new URL('.', import.meta.url));
const pairCode = () => {
  const code = execFileSync(
    'bun',
    [join(verify, 'rpc.ts'), 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic layout browser' })],
    { encoding: 'utf8', env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') } }
  ).match(/"code":\s*"([^"]+)"/)?.[1];
  assert(code, 'no pairing code');
  return code;
};

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const observed = {};
process.on('exit', () => writeFileSync(join(run, 'evidence', 'your-work-placement.json'), JSON.stringify(observed, null, 2)));
try {
  for (const width of [1600, 2600]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'en-US' });
    await context.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    const column = page.locator('.neo-scene-list');
    const workTab = page.getByRole('tab', { name: /^Your work/ });
    const state = async () => ({
      columnVisible: await column.isVisible(),
      columnIsTabPanel: (await column.count()) > 0 && (await column.getAttribute('role')) === 'tabpanel',
      workTabs: await workTab.count(),
      panelOpen: (await page.getByRole('dialog').count()) > 0,
    });
    await page.goto(`${base}/pair#${pairCode()}`);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
    await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
    await page.goto(`${base}/neo`);
    await column.waitFor({ state: 'visible' });
    observed[`${width}-closed`] = await state();
    await page.screenshot({ path: join(run, 'evidence', `your-work-${width}-closed.png`) });
    await page.getByRole('button', { name: /^Open .*Report/ }).first().click();
    await page.getByRole('dialog').waitFor();
    observed[`${width}-open`] = await state();
    await page.screenshot({ path: join(run, 'evidence', `your-work-${width}-open.png`) });
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(run, 'evidence', 'your-work-placement.json'), JSON.stringify(observed, null, 2));
console.log(JSON.stringify(observed, null, 2));
assert.deepEqual(observed['1600-closed'], {
  columnVisible: true,
  columnIsTabPanel: false,
  workTabs: 0,
  panelOpen: false,
});
assert.deepEqual(observed['1600-open'], {
  columnVisible: false,
  columnIsTabPanel: false,
  workTabs: 1,
  panelOpen: true,
});
assert.deepEqual(observed['2600-closed'], observed['1600-closed']);
assert.deepEqual(observed['2600-open'], {
  columnVisible: true,
  columnIsTabPanel: false,
  workTabs: 0,
  panelOpen: true,
});
console.log('PASS: Your work shows once at 1600px and 2600px, panel open and closed');
