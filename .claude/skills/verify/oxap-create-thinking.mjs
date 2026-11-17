import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [port, code, output] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
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
    await page.evaluate(
      ({ theme }) => {
        localStorage.setItem(
          'hyperneo_new_chat_selection',
          JSON.stringify({
            model: { id: 'codex-6-luna', provider: 'anthropic-codex' },
            thinkingLevel: 'off',
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
    await page.screenshot({ path: `${output}/oxap-create-${theme}.png`, animations: 'disabled' });
    if (theme === 'light') {
      await page.getByPlaceholder('Ask anything to start a new chat...').fill('Hello');
      await page.getByRole('button', { name: 'Start chat' }).click();
      await page.waitForURL(/\/session\//, { timeout: 15000 });
      assert.equal(await page.getByText('OXAP Codex does not take a thinking level.').count(), 0);
      console.log('OXAP create accepted with persisted thinking=off; slider absent');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
