import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Sidebar check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`http://127.0.0.1:${port}/sessions`);
  await page.getByRole('button', { name: 'New session in neo-read' }).waitFor({ state: 'attached' });
  await page.getByTestId('project-group-header').filter({ hasText: 'neo-read' }).hover();
  await page.screenshot({ path: `${run}/evidence/sidebar-system-hover.png` });
  const count = await page.getByRole('button', { name: 'Remove project neo-read' }).count();
  console.log(`Remove control count: ${count}`);
  assert.equal(count, 1, 'empty system project must expose remove');
} finally {
  await browser.close();
}
