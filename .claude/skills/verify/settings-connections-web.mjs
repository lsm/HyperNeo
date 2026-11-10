import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: node settings-connections-web.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const evidence = join(run, 'evidence');
mkdirSync(evidence, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const db = join(run, 'data', 'daemon.db');
const rpc = (name, input) =>
  execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') },
  });
const settingsHash = () =>
  createHash('sha256')
    .update(execFileSync('sqlite3', ['-readonly', db, 'SELECT * FROM global_settings'], { encoding: 'utf8' }))
    .digest('hex');

const requests = [];
let failProbe = false;
const fixture = createServer((request, response) => {
  requests.push({ url: request.url, origin: request.headers.origin, version: request.headers['anthropic-version'] });
  response.writeHead(failProbe ? 503 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
});
await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
const endpoint = `http://127.0.0.1:${fixture.address().port}/anthropic`;

const code = rpc('device.pair.create', { kind: 'human', name: 'Synthetic settings browser' }).match(/"code":\s*"([^"]+)"/)?.[1];
assert(code, 'no pairing code');
rpc('rpc:customEndpoints.add', {
  endpoint: {
    id: 'synthetic',
    name: 'Synthetic endpoint',
    type: 'anthropic-messages',
    baseUrl: endpoint,
    headers: { 'anthropic-version': '2099-01-01' },
    models: [{ id: 'fixture-model' }],
  },
});

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const result = { tabs: [] };
const TABS = [
  ['providers', 'Providers', 'Providers'],
  ['connections', 'Accounts', 'Accounts'],
  ['devices', 'Devices', 'Devices'],
  ['remote-daemons', 'Remote Daemons', 'Remote Daemons'],
  ['exa', 'Advanced', 'Exa Web Search'],
];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(base) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });

  const before = settingsHash();
  const tabs = page.getByRole('navigation', { name: 'Connections & Services' });
  const open = async (label, heading) => {
    await tabs.locator('[aria-current="page"]', { hasText: new RegExp(`^${label}$`) }).waitFor({ timeout: 5000 });
    await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
  };
  for (const [section, label, heading] of TABS) {
    await page.goto(`${base}/settings?tab=${section}`);
    await open(label, heading);
    await page.reload();
    await open(label, heading);
    await page.screenshot({ path: join(evidence, `${section}-1280.png`) });
    result.tabs.push({ section, label, deepLink: true });
  }

  const sidebar = page.getByRole('navigation', { name: 'Settings sections' });
  result.sidebar = await sidebar.getByRole('button').allInnerTexts();
  for (const gone of ['Providers', 'Connections', 'Devices', 'Remote Daemons', 'Exa Search'])
    assert(!result.sidebar.includes(gone), `${gone} is still in the sidebar`);
  await sidebar.getByRole('button', { name: 'Connections & Services' }).click();
  await open('Providers', 'Providers');
  for (const [section, label, heading] of TABS.slice(1)) {
    await tabs.getByRole('button', { name: label, exact: true }).click();
    await open(label, heading);
    assert(page.url().endsWith(`/settings?tab=${section}`), page.url());
  }
  await page.waitForTimeout(200);
  await page.goBack();
  await open('Remote Daemons', 'Remote Daemons');
  await page.goForward();
  await open('Advanced', 'Exa Web Search');
  assert.equal(settingsHash(), before, 'opening and moving between tabs wrote settings');
  result.zeroWrites = true;

  await page.goto(`${base}/settings?tab=exa`);
  await page.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();
  assert(!(await page.locator('body').innerText()).includes('Thinking'), 'Advanced shows a thinking control');
  const saved = () => execFileSync('sqlite3', ['-readonly', db, 'SELECT * FROM global_settings'], { encoding: 'utf8' });
  const interval = page.getByRole('spinbutton');
  const pollingSaved = async (value) => {
    await interval.fill(String(value));
    await interval.blur();
    for (let tries = 0; tries < 50 && !saved().includes(`"githubPollingInterval":${value}`); tries += 1)
      await page.waitForTimeout(100);
    assert(saved().includes(`"githubPollingInterval":${value}`), `interval ${value} not saved`);
  };
  await pollingSaved(0);
  await pollingSaved(60);
  await interval.fill('-1');
  await interval.blur();
  await page.getByText(/must be a whole number/).waitFor();
  assert.equal(await interval.inputValue(), '60');
  assert(saved().includes('"githubPollingInterval":60'));
  await page.reload();
  await page.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();
  assert.equal(await page.getByRole('spinbutton').inputValue(), '60');
  result.polling = { zero: true, sixty: true, refused: true };
  await page.getByRole('switch').click();
  for (let tries = 0; tries < 50 && !/"exa":\{[^}]*"enabled":true/.test(saved()); tries += 1)
    await page.waitForTimeout(100);
  assert(/"exa":\{[^}]*"enabled":true/.test(saved()), 'Exa switch not saved');
  result.exaEnabledSaved = true;

  await page.goto(`${base}/settings?tab=connections`);
  await page.getByRole('button', { name: 'Connect Google' }).waitFor();
  await page.getByText('No accounts connected.').waitFor();

  execFileSync('bun', ['run', 'packages/cli/main.ts', 'pair', '--kind', 'relay', '--name', 'Push relay'], {
    env: {
      ...process.env,
      HOME: join(run, 'home'),
      NODE_ENV: 'test',
      HYPERNEO_DATA_DIR: join(run, 'data'),
      HYPERNEO_SESSION_DOOR: join(run, 'data', 'session-door.sock'),
    },
    stdio: 'ignore',
  });
  await page.goto(`${base}/settings?tab=devices`);
  await page.getByRole('button', { name: 'Allow Push relay' }).click();
  await page.getByText('No codes are waiting for Allow.').waitFor({ timeout: 10000 });
  result.deviceAllow = true;

  await page.goto(`${base}/settings?tab=remote-daemons`);
  await page.getByPlaceholder('ws://host:8484/ws').fill('ws://127.0.0.1:9/ws');
  const quiet = new Set((await page.locator('body').innerText()).split('\n'));
  await page.getByRole('button', { name: 'Test', exact: true }).first().click();
  await page.waitForFunction(
    (known) => document.body.innerText.split('\n').some((line) => line.trim() && !known.includes(line)),
    [...quiet],
    { timeout: 20000 }
  );
  result.remoteFailure = (await page.locator('body').innerText()).split('\n').filter((line) => line.trim() && !quiet.has(line));
  assert(!result.remoteFailure.some((line) => /reachable$/.test(line) && !/un/i.test(line)), 'remote Test passed');
  await page.screenshot({ path: join(evidence, 'remote-failure-1280.png') });

  await page.goto(`${base}/settings?tab=providers`);
  await page.getByText('Synthetic endpoint', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const start = requests.length;
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByText(/^Reached /).waitFor({ timeout: 8000 });
  const probe = requests.slice(start).at(-1);
  assert(probe, 'Test connection did not reach the fixture');
  assert.equal(probe.origin, undefined, 'the probe came from the browser');
  assert.equal(probe.version, '2099-01-01');
  failProbe = true;
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByText(/HTTP 503/).waitFor({ timeout: 8000 });
  failProbe = false;
  result.endpointTest = { probe, failureShown: true };
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [section, label, heading] of TABS) {
    await page.goto(`${base}/settings?tab=${section}`);
    await open(label, heading);
    const box = await tabs.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= 390, `${section} tabs leave the phone width`);
    await page.screenshot({ path: join(evidence, `${section}-390.png`) });
  }
  result.phoneWidth = true;
  await context.close();
  result.pageErrors = errors;
  assert.deepEqual(errors, []);
  result.passed = true;
} finally {
  writeFileSync(join(evidence, 'settings-connections.json'), JSON.stringify(result, null, 2));
  await browser.close();
  fixture.close();
}
console.log(JSON.stringify(result));
