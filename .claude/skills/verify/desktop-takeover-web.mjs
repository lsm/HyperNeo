import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, out, run, sessionId] = process.argv.slice(2);
assert(port && out && run && sessionId, 'usage: desktop-takeover-web.mjs <port> <evidence-dir> <run-dir> <session>');
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
    `env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Desktop takeover proof"}'`,
    { encoding: 'utf8' }
  )
).reply;
assert(pair.ok, JSON.stringify(pair));
const observations = [];
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
  await page.getByRole('button', { name: 'Settings and connection' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Settings and connection' });
  await drawer.getByText('Agent is using the desktop').waitFor();
  await drawer.getByText('Book the dentist on the clinic site').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, 'drawer-running.png') });
  observations.push({ view: 'drawer', state: 'running', stopButton: await drawer.getByRole('button', { name: 'Stop and take over' }).count() });

  await page.goto(`${base}/session/${sessionId}`);
  const control = page.getByRole('region', { name: 'Desktop control' });
  await control.getByText('Agent is using the desktop').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'session-running.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'session-running-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await control.getByRole('button', { name: 'Stop and take over' }).click();
  await control.getByText('Stopped. The desktop is yours.').waitFor({ timeout: 15000 });
  observations.push({ view: 'session', state: 'stopped', buttons: await control.getByRole('button').count() });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'session-stopped.png') });
} finally {
  writeFileSync(join(out, 'web-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(observations));
