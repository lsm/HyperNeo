import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, directory, name = 'quote-expanded-click'] = process.argv.slice(2);
assert(port && directory, 'usage: node quote-expanded-click-check.mjs <port> <run-dir> [name]');
assert.notEqual(port, '8399');
const base = `http://127.0.0.1:${port}`;
const db = `${directory}/data/daemon.db`;
const log = execFileSync('sqlite3', ['-readonly', db, "SELECT 1"], { encoding: 'utf8' });
assert(log.includes('1'));
const root = execFileSync(
  'sqlite3',
  ['-readonly', db, "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL"],
  { encoding: 'utf8' }
).trim();
assert(root.startsWith('neo:'), 'Open root with rpc.ts neo.open first');
const conversationId = root.slice(4);
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
function seed() {
  const publicationId = crypto.randomUUID();
  const publication = {
    conversationId,
    publicationId,
    askOrigin: { sessionId: root, messageId: crypto.randomUUID() },
    producerInput: { sessionId: root, messageId: crypto.randomUUID() },
    shortText: 'Expanded composer click target.',
    fullText: 'Detailed notes that stay behind Details.',
    links: [],
  };
  execFileSync('sqlite3', [
    db,
    `INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at)
     VALUES (${quote(conversationId)}, ${quote(publicationId)}, ${quote(JSON.stringify(publication))},
       ${quote(new Date().toISOString())});`,
  ]);
  return publicationId;
}
const evidence = `${directory}/evidence`;
mkdirSync(evidence, { recursive: true });
const { chromium } = createRequire(import.meta.url)(
  process.env.VERIFY_PLAYWRIGHT || 'playwright'
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const made = JSON.parse(
  execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}'], {
    encoding: 'utf8',
  })
).reply;
const pairing = await browser.newContext();
assert.equal(
  (
    await pairing.request.post(`${base}/pair`, {
      headers: { origin: base },
      data: { code: made.code, name: 'Synthetic quote press browser' },
    })
  ).status(),
  200
);
const storageState = await pairing.storageState();
await pairing.close();
const results = [];
for (const width of [1280, 390]) {
  const context = await browser.newContext({
    storageState,
    viewport: { width, height: width === 390 ? 844 : 900 },
    hasTouch: width === 390,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(String(error)));
  const publicationId = seed();
  const entry = { width };
  try {
    await page.goto(`${base}/neo`);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.waitFor();
    await page.waitForTimeout(1200);
    const form = page.locator('form.neo-composer-input');
    const source = page.locator(`[data-message-ref="${publicationId}"]`);
    const reply = source.getByRole('button', { name: 'Reply to Neo’s message' });
    await reply.waitFor();
    await input.click();
    await page.waitForFunction(() => document.querySelector('.neo-composer-input.is-focused'));
    await page.waitForTimeout(400);
    const box = await reply.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(90);
    entry.pressedHeight = Math.round(
      await form.evaluate((element) => element.getBoundingClientRect().height)
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    entry.quoteAfterFirstClick = await page.locator('[data-quote-bar]').count();
    entry.expandedAfterFirstClick = await form.evaluate((element) =>
      element.className.includes('is-focused')
    );
    await page.screenshot({ path: `${evidence}/${name}-${width}.png` });
    assert.equal(entry.pressedHeight, 108, 'composer must stay expanded while the press is down');
    assert.equal(entry.quoteAfterFirstClick, 1, 'one press must add the quote');
    assert.equal(entry.expandedAfterFirstClick, true, 'the composer keeps its expanded size');
  } catch (error) {
    entry.error = String(error);
    await page.screenshot({ path: `${evidence}/${name}-${width}-failure.png` });
  }
  await context.close();
  results.push(entry);
}
writeFileSync(`${evidence}/${name}.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
assert(results.every((entry) => !entry.error), 'Reply must quote on one human-paced press');
