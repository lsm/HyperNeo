import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: about-links-view.mjs <port> <run-dir>');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/settings?tab=about`);
  const github = page.getByRole('link', { name: 'GitHub' });
  await github.waitFor({ timeout: 30000 });
  const docs = page.getByRole('link', { name: /docs \(upstream\)/ });
  const result = {
    url: new URL(page.url()).pathname + new URL(page.url()).search,
    github: await github.getAttribute('href'),
    docsLabel: (await docs.innerText()).trim(),
    docsHref: await docs.getAttribute('href'),
  };
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/about-1280.png` });
  writeFileSync(`${run}/evidence/about-links.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(result.url, '/settings?tab=about');
  assert.equal(result.github, 'https://github.com/lsm/HyperNeo');
  assert.equal(result.docsLabel, 'Anthropic / Claude Agent SDK docs (upstream)');
  assert.equal(result.docsHref, 'https://docs.anthropic.com');
} finally {
  await browser.close();
}
