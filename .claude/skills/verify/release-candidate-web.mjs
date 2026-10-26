import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const [port, run] = process.argv.slice(2);
assert(Number(port) > 0 && port !== '8399');
const proof = JSON.parse(readFileSync(`${run}/evidence/steps.json`, 'utf8'));
const life = proof.steps.lifeAdmin.sessions.find(row => row.title.includes('RC life admin'));
assert(life, 'life-admin session exists');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  await page.getByText('Release candidate Neo chat is working.', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${run}/evidence/neo-chat.png` });
  await page.goto(`http://127.0.0.1:${port}/session/${life.id}`);
  await page.getByText('Release candidate life-admin session is working.', { exact: false }).first().waitFor();
  await page.screenshot({ path: `${run}/evidence/life-admin.png` });
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify({ pass: true, neoVisibleReply: true, lifeAdminVisibleReply: true, width: 1280 }, null, 2));
} finally { await browser.close(); }
