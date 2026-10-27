import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory, name = 'quote-summary'] = process.argv.slice(2);
assert(port && directory, 'usage: node quote-summary-check.mjs <port> <run-dir> [evidence-name]');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const db = `${run}/data/daemon.db`;
const root = execFileSync(
  'sqlite3',
  ['-readonly', db, "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL"],
  { encoding: 'utf8' }
).trim();
assert(root.startsWith('neo:'), 'Open root with rpc.ts neo.open first');
const conversationId = root.slice(4);
const publicationId = crypto.randomUUID();
const shortText = process.env.VERIFY_QUOTE_LONG === '1' ? 'a'.repeat(350) : 'The app is ready for review.';
const expected = process.env.VERIFY_QUOTE_LONG === '1' ? `${'a'.repeat(300)}…` : shortText;
const fullText = '**The app:** Detailed implementation notes that belong in the expanded message.';
const publication = {
  conversationId,
  publicationId,
  askOrigin: { sessionId: root, messageId: crypto.randomUUID() },
  producerInput: { sessionId: root, messageId: crypto.randomUUID() },
  shortText,
  fullText,
  links: [],
};
const sqlString = (text) => `'${text.replaceAll("'", "''")}'`;
execFileSync('sqlite3', [
  db,
  `INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at)
   VALUES (${sqlString(conversationId)}, ${sqlString(publicationId)},
     ${sqlString(JSON.stringify(publication))}, ${sqlString(new Date().toISOString())});`,
]);
const evidence = `${run}/evidence`;
mkdirSync(evidence, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const results = [];
try {
  await page.goto(`http://127.0.0.1:${port}/neo`);
  const source = page.locator(`[data-message-ref="${publicationId}"]`);
  await source.getByRole('button', { name: 'Reply to Neo’s message' }).waitFor();
  for (const via of ['button', 'menu']) {
    if (via === 'menu') {
      await source.evaluate((node) => node.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, touches: [new Touch({ identifier: 0, target: node, clientX: 100, clientY: 100 })],
      })));
      await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    } else {
      await source.getByRole('button', { name: 'Reply to Neo’s message' }).click();
    }
    const composer = page.getByRole('region', { name: /^Replying to Neo/ });
    const preview = await composer.locator('[data-quote-bar] .line-clamp-2').innerText();
    await page.screenshot({ path: `${evidence}/${name}-${via}-composer.png`, fullPage: true });
    const reply = `Quote summary verification ${via} ${publicationId}`;
    await page.locator('textarea#neo-thought').fill(reply);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const sent = page.locator('article.neo-message-user[data-public-entry]').filter({ hasText: reply });
    await sent.waitFor();
    const sentQuote = await sent.locator('[data-quote-bar] .line-clamp-2').innerText();
    await page.screenshot({ path: `${evidence}/${name}-${via}-sent.png`, fullPage: true });
    results.push({ via, preview, sentQuote, expected, pass: preview === expected && sentQuote === expected });
    await composer.waitFor({ state: 'detached' });
  }
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  assert(results.every((result) => result.pass), 'Composer and sent quote must both show shortText');
} catch (error) {
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ results, error: String(error) }, null, 2));
  await page.screenshot({ path: `${evidence}/${name}-failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
