import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { verifyClaudeLogin } from './claude-login-web.mjs';
import { pairMessageCopyBrowser } from './neo-whole-message-copy-web.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const run = process.argv[2];
const observed = `${run}/evidence/observed.json`;
for (let i = 0; i < 1200; i += 1) {
  if (existsSync(observed) && JSON.parse(readFileSync(observed, 'utf8')).pass) break;
  await new Promise((done) => setTimeout(done, 250));
}
const browser = await chromium.launch(
  process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}
);
const fixture = JSON.parse(readFileSync(`${run}/pair.json`, 'utf8'));
const page = await browser.newContext({
  storageState: await pairMessageCopyBrowser(browser, fixture),
}).then((context) => context.newPage());
try {
  await verifyClaudeLogin(page, run);
  console.log(`BROWSER PASS ${run}/evidence/browser.json`);
} catch (error) {
  await page.screenshot({ path: `${run}/evidence/browser-failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
