import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [run, port, evidence] = process.argv.slice(2);
assert.notEqual(port, '8399');
mkdirSync(evidence, { recursive: true });
const rpc = (name, input) =>
  JSON.parse(
    execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
      env: { ...process.env, VERIFY_PORT: port },
      encoding: 'utf8',
    })
  ).reply;
const opened = rpc('neo.open', {});
assert(opened.value?.sessionId ?? opened.sessionId, JSON.stringify(opened));
const conversationId = (opened.value?.sessionId ?? opened.sessionId).replace(/^neo:/, '');
const content =
  '## Sent as is\n\nThe whole message stays open.\n\n| Source | Finding |\n| --- | --- |\n| A | Different |\n\n> Reported evidence, not verified completion.\n\n```text\nFictional detail\n```';
const seed = ({ verbatim, shortText, fullText }) => {
  const db = new (createRequire(import.meta.url)('bun:sqlite').Database)(
    `${run}/data/daemon.db`,
    'rw'
  );
  db.run(
    'INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
    conversationId,
    crypto.randomUUID(),
    JSON.stringify({
      conversationId,
      publicationId: crypto.randomUUID(),
      verbatim,
      shortText,
      fullText,
      links: [],
    }),
    new Date().toISOString()
  );
  db.close();
};
const clear = () => {
  const db = new (createRequire(import.meta.url)('bun:sqlite').Database)(
    `${run}/data/daemon.db`,
    'rw'
  );
  db.run('DELETE FROM neo_publications');
  db.close();
};
clear();
seed({
  verbatim: true,
  shortText: 'A collapsed preview must not appear.',
  fullText: content,
});
seed({
  shortText: 'The comparison is ready. Nothing has been executed.',
  fullText: content,
});
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const results = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${port}`;
  await page.route('**/*', (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort()
  );
  await page.goto(`${base}/neo`);
  const bubble = (label) =>
    page
      .locator('article')
      .filter({ hasText: label })
      .first();
  const verbatimBubble = bubble('The whole message stays open.');
  await verbatimBubble.locator('table').first().waitFor({ timeout: 15000 });
  results.verbatim = {
    table: await verbatimBubble.locator('table').count(),
    quote: await verbatimBubble.locator('blockquote').count(),
    code: await verbatimBubble.locator('pre code').count(),
    moreButtons: await verbatimBubble.getByRole('button', { name: /^more$/ }).count(),
    details: await verbatimBubble.locator('[data-publication-details]').count(),
  };
  assert.equal(results.verbatim.table, 1);
  assert.equal(results.verbatim.quote, 1);
  assert.equal(results.verbatim.code, 1);
  assert.equal(results.verbatim.moreButtons, 0);
  assert.equal(results.verbatim.details, 0);
  const controlBubble = bubble('The comparison is ready. Nothing has been executed.');
  await controlBubble.getByRole('button', { name: /^more$/ }).waitFor({ timeout: 15000 });
  results.control = {
    moreButtons: await controlBubble.getByRole('button', { name: /^more$/ }).count(),
    tableWhileCollapsed: await controlBubble.locator('table').count(),
  };
  assert.equal(results.control.moreButtons, 1);
  assert.equal(results.control.tableWhileCollapsed, 0);
  await page.screenshot({ path: `${evidence}/verbatim-publication.png`, fullPage: true });
  await page.close();
} finally {
  await browser.close();
  writeFileSync(
    `${evidence}/verbatim-publication.json`,
    JSON.stringify({ run, port, conversationId, results }, null, 2)
  );
}
console.log('PASS: verbatim renders in full with no more control; non-verbatim unchanged');
