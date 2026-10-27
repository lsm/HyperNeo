import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory, mode = 'after'] = process.argv.slice(2);
assert(port && directory, 'usage: node message-context-menu-check.mjs <port> <run> [before|after]');
assert.notEqual(port, '8399');
assert(['before', 'after'].includes(mode));
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const db = `${run}/data/daemon.db`;
const root = execFileSync(
  'sqlite3',
  [
    '-readonly',
    db,
    "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL",
  ],
  { encoding: 'utf8' }
).trim();
assert(root.startsWith('neo:'), 'Run rpc.ts neo.open first');
const publicationId = crypto.randomUUID();
const publication = {
  conversationId: root.slice(4),
  publicationId,
  shortText: 'Browser context menu verification.',
  fullText: 'Detailed context menu verification text.',
  links: [],
};
const sql = (value) => `'${value.replaceAll("'", "''")}'`;
execFileSync('sqlite3', [
  db,
  `INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at)
   VALUES (${sql(root.slice(4))}, ${sql(publicationId)}, ${sql(JSON.stringify(publication))},
   ${sql(new Date().toISOString())});`,
]);
const evidence = `${run}/evidence`;
mkdirSync(evidence, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true });
const results = { mode };
try {
  await page.goto(`http://127.0.0.1:${port}/neo`);
  const source = page.locator(`[data-message-ref="${publicationId}"]`);
  const reply = source.getByRole('button', { name: 'Reply to Neo’s message' });
  await reply.waitFor();
  await page.evaluate(() =>
    document.addEventListener('contextmenu', (event) => {
      window.contextMenuPrevented = event.defaultPrevented;
    })
  );
  await source.locator('p').first().click({ button: 'right' });
  results.prevented = await page.evaluate(() => window.contextMenuPrevented);
  results.customMenu = await page.getByRole('menu', { name: 'Message actions' }).count();
  assert.equal(results.prevented, mode === 'before');
  assert.equal(results.customMenu, mode === 'before' ? 1 : 0);
  await page.screenshot({ path: `${evidence}/message-context-${mode}.png` });
  await page.keyboard.press('Escape');
  if (mode === 'after') {
    await reply.click();
    await page.getByRole('region', { name: /^Replying to Neo/ }).waitFor();
    results.footerReply = true;
    await page.screenshot({ path: `${evidence}/message-context-reply.png` });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data) => {
          window.sharedMessage = data.text;
        },
      });
    });
    await source.tap();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole('menu', { name: 'Message actions' }).count(), 0);
    results.shortTapNoMenu = true;
    await source.evaluate((node) =>
      node.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [new Touch({ identifier: 0, target: node, clientX: 100, clientY: 100 })],
        })
      )
    );
    await source.dispatchEvent('touchmove');
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole('menu', { name: 'Message actions' }).count(), 0);
    results.touchMoveCancels = true;
    await source.evaluate((node) =>
      node.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [new Touch({ identifier: 0, target: node, clientX: 100, clientY: 100 })],
        })
      )
    );
    await page.getByRole('menuitem', { name: 'Share', exact: true }).waitFor();
    results.longPressActions = await page.getByRole('menuitem').allTextContents();
    assert.deepEqual(results.longPressActions, ['Select text', 'Copy', 'Share', 'Reply']);
    await source.dispatchEvent('touchend');
    await page.screenshot({ path: `${evidence}/message-context-touch.png` });
    await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.sharedMessage),
      `${publication.shortText}\n\n${publication.fullText}`
    );
    results.touchShare = true;
    results.desktopShareButton = await source.getByRole('button', { name: /share/i }).count();
    assert.equal(results.desktopShareButton, 0);
  }
  writeFileSync(`${evidence}/message-context-${mode}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
