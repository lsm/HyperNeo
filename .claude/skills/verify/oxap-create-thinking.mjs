import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [port, code, output] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const before = process.env.OXAP_UI_BEFORE === '1';
let sessionPath;
try {
  const initial = await browser.newPage();
  await initial.goto(`${base}/pair#${code}`);
  await initial.getByLabel('Name for this browser').fill('Synthetic browser');
  await initial.getByRole('button', { name: 'Pair this browser' }).click();
  await initial.getByText('This browser is paired.').waitFor();
  const storageState = await initial.context().storageState();
  await initial.close();
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      storageState,
      colorScheme: theme,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`${base}/sessions`);
    if (theme === 'light') {
      await page.getByRole('alert').getByText('Synthetic provider lookup failure').waitFor();
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });
      console.log('Provider lookup error surfaced and retry succeeded');
    }
    await page.evaluate(
      ({ theme }) => {
        localStorage.setItem(
          'hyperneo_new_chat_selection',
          JSON.stringify({
            model: { id: 'codex-6-luna', provider: 'anthropic-codex' },
            thinkingLevel: 'off',
            sandbox: true,
          })
        );
        localStorage.setItem('theme', theme);
      },
      { theme }
    );
    await page.reload();
    await page.getByRole('button', { name: 'Choose model and thinking' }).waitFor();
    await page.getByText('Synthetic Codex').first().waitFor();
    await page.getByRole('button', { name: 'Choose model and thinking' }).click();
    assert.equal(await page.getByRole('slider', { name: 'Thinking' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Sandbox' }).count(), 0);
    await page.screenshot({ path: `${output}/oxap-create-${theme}.png`, animations: 'disabled' });
    if (theme === 'light') {
      await page.getByPlaceholder('Ask anything to start a new chat...').fill('Hello');
      await page.getByRole('button', { name: 'Start chat' }).click();
      await page.waitForURL(/\/session\//, { timeout: 15000 });
      assert.equal(await page.getByText('OXAP Codex does not take a thinking level.').count(), 0);
      await page.getByRole('button', { name: 'Choose model and thinking' }).click();
      assert.equal(await page.getByRole('slider', { name: 'Thinking' }).count(), 0);
      sessionPath = new URL(page.url()).pathname;
      console.log('OXAP session model picker hides thinking');
      console.log('OXAP create accepted with persisted thinking=off and sandbox=true; controls absent');
    }
    if (theme === 'dark') {
      await page.goto(`${base}${sessionPath}`);
      await page.getByRole('button', { name: 'Choose model and thinking' }).waitFor();
    }
    if (!before) {
      await page.getByText(/This harness accepts text only/).waitFor();
      await page.getByTitle('More options').click();
      assert.equal(await page.getByRole('button', { name: 'Attach image' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Tools', exact: true }).count(), 0);
      await page.getByTitle('More options').click();
    }
    await page.screenshot({ path: `${output}/oxap-chat-${theme}.png`, animations: 'disabled' });
    await page.goto(`${base}/settings?tab=providers`);
    await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
    if (!before) {
      assert.equal(await page.getByLabel('Harness', { exact: true }).inputValue(), 'oxap-codex');
      await page.getByLabel('Harness executable').waitFor();
      await page.getByLabel('Hub binary').waitFor();
    }
    await page.screenshot({ path: `${output}/oxap-provider-${theme}.png`, animations: 'disabled' });
    if (!before && theme === 'dark') {
      await page.getByLabel('Harness executable').fill('relative');
      await page.getByRole('button', { name: 'Save harness' }).click();
      await page.getByText(/needs an absolute executable path/).waitFor();
      await page.getByLabel('Harness', { exact: true }).selectOption('sdk');
      await page.getByRole('button', { name: 'Save harness' }).click();
      await page.getByText('Harness saved').waitFor();
      await page.reload();
      await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
      assert.equal(await page.getByLabel('Harness', { exact: true }).inputValue(), 'sdk');
      console.log('Invalid executable refused; switching back to Claude Code persisted');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
