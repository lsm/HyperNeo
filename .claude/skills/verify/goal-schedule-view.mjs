import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: goal-schedule-view.mjs <test-port> <run-dir>');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const evidence = JSON.parse(readFileSync(`${run}/evidence/goal-schedule.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  await page.goto(`http://127.0.0.1:${port}/session/${evidence.root}`);
  const wake = page.getByText('Goal "Publish the adapter guide":', { exact: false }).first();
  await wake.waitFor({ timeout: 30000 });
  await wake.scrollIntoViewIfNeeded();
  const visible = await wake.innerText();
  assert(visible.includes('mandate.md#guides') && visible.includes('goal.journal.append'), visible);
  await page.screenshot({ path: `${run}/evidence/goal-schedule-transcript.png`, fullPage: true });
  writeFileSync(`${run}/evidence/goal-schedule-view.json`, JSON.stringify({ url: page.url(), visible }, null, 2));
  console.log('PASS: goal wake visible in the session transcript; screenshot captured.');
} finally {
  await browser.close();
}
