import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, code, executable, run] = process.argv.slice(2);
const origin = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ executablePath: process.env.VERIFY_BROWSER, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  );
  const paired = await page.request.post(`${origin}/pair`, {
    headers: { origin }, data: { code, name: 'Synthetic DeepSeek browser' },
  });
  assert.equal(paired.status(), 200);
  await page.goto(`${origin}/settings?tab=providers`);
  const provider = page.getByText('Synthetic DeepSeek', { exact: true }).first();
  await provider.click();
  const client = page.getByLabel('Client', { exact: true });
  await client.selectOption('oxap-deepseek');
  await page.getByLabel('DeepSeek harness path').fill(executable);
  const route = page.getByPlaceholder('opencode-go');
  await route.fill('opencode-go');
  await page.getByRole('button', { name: 'Save client' }).click();
  await page.getByText('Client saved', { exact: true }).waitFor();
  await page.reload();
  await provider.click();
  assert.equal(await client.inputValue(), 'oxap-deepseek');
  assert.equal(await route.inputValue(), 'opencode-go');
  await page.getByPlaceholder('Enter API key').waitFor();
  await page.screenshot({ path: join(run, 'evidence/deepseek-routing-settings.png'), animations: 'disabled' });

  await page.goto(`${origin}/sessions`);
  const picker = page.getByRole('button', { name: 'Choose model, client and thinking' });
  await picker.click();
  await page.getByRole('button', { name: /^Model(?: & thinking)?,/ }).click();
  await page.getByRole('button', { name: /^DeepSeek V4 Pro/ }).click();
  assert.equal(await picker.getAttribute('aria-description'), 'Client: OXAP DeepSeek');
  await page.keyboard.press('Escape');
  await picker.click();
  await page.getByRole('button', { name: 'Client, OXAP DeepSeek' }).click();
  await page.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await picker.click();
  await page.getByRole('button', { name: /^Model(?: & thinking)?,/ }).click();
  await page.getByRole('group', { name: 'Models' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^DeepSeek V4/ }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Ask anything to start a new chat...').fill('Check availability');
  assert.equal(await page.getByRole('button', { name: 'Start chat' }).isDisabled(), true);
  console.log(JSON.stringify({ settingsSaved: 1, modelSelections: 1, officialKeyField: true, sdkRouteHidden: true, sdkStartDisabled: true }));
} finally {
  await browser.close();
}
