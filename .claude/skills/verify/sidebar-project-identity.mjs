import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [port, out] = process.argv.slice(2);
assert(port && out && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const origin = `http://127.0.0.1:${port}`;
  await page.goto(`${origin}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Sidebar check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${origin}/sessions`);
  const rows = page.getByTestId('project-group-header').filter({ hasText: 'fixture-repo' });
  await rows.nth(1).waitFor();
  const count = await rows.count();
  console.log(`Visible rows for three checkouts of two repositories: ${count}`);
  await page.screenshot({ path: `${out}/sidebar-project-identity.png` });
  assert.equal(count, 2);
} finally {
  await browser.close();
}
