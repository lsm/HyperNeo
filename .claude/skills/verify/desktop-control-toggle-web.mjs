import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, out, run] = process.argv.slice(2);
assert(port && out && run, 'usage: desktop-control-toggle-web.mjs <port> <evidence-dir> <run-dir>');
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
    `env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Desktop control proof"}'`,
    { encoding: 'utf8' }
  )
).reply;
assert(pair.ok, JSON.stringify(pair));
const observations = [];
const expand = async (row, title) => {
  const show = row.getByRole('button', { name: `Show details: ${title}` });
  await row.getByRole('button', { name: new RegExp(`(Show|Hide) details: ${title}`) }).waitFor();
  if (await show.count()) await show.click();
};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  await page.goto(`${base}/pair#${pair.code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/neo`);
  const row = page.locator('[data-ask-todo="dentist"]').first();
  await expand(row, 'Book the dentist on the clinic site');
  const box = row.getByRole('checkbox', { name: 'Let the agent use this computer' });
  await box.waitFor();
  const card = page.locator('[data-ask-todo="dentist"]').first().locator('xpath=ancestor::article[1]');
  const shot = async (name) => {
    await page.waitForTimeout(400);
    await ((await card.count()) ? card : row).screenshot({ path: join(out, name) });
  };
  observations.push({ todo: 'dentist', checkedBefore: await box.isChecked() });
  await shot('todo-off.png');
  await box.click();
  await page.waitForFunction(
    () => document.querySelector('[data-ask-todo="dentist"] input[type=checkbox]')?.checked === true
  );
  await page.reload();
  const again = page.locator('[data-ask-todo="dentist"]').first();
  await expand(again, 'Book the dentist on the clinic site');
  const reloaded = again.getByRole('checkbox', { name: 'Let the agent use this computer' });
  await reloaded.waitFor();
  observations.push({ todo: 'dentist', checkedAfterReload: await reloaded.isChecked() });
  await shot('todo-on.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('todo-on-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await expand(page.locator('[data-ask-todo="taxes"]').first(), 'File the tax form');
  observations.push({
    todo: 'taxes',
    checked: await page.locator('[data-ask-todo="taxes"]').first().getByRole('checkbox', { name: 'Let the agent use this computer' }).isChecked(),
  });
} finally {
  writeFileSync(join(out, 'web-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(observations));
