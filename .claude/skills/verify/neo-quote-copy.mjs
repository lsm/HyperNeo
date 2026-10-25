import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, phase = 'after'] = process.argv.slice(2);
assert(port && run && port !== '8399');
assert(readFileSync(`${run}/daemon.log`, 'utf8').includes(`Database: ${run}/data/daemon.db`));
const rpc = (name, input = {}) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
  env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
})).reply;
const opened = rpc('neo.open');
assert(opened.ok);
const conversationId = opened.sessionId.slice(4);
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const code = '    def f():\n        return 1\n\n\n    def g():\n        return 2';
const formula = 'x^2 + y^2 = z^2';
const fence = `> \`\`\`python\n${code.split('\n').map((line) => `> ${line}`).join('\n')}\n> \`\`\``;
const text = `英文 message（可直接复制）\n\n> Hello **friend** and [team](https://example.com).\n>\n> Second \`paragraph\`.\n>\n${fence}\n>\n> $$${formula}$$\n>\n> > Nested *reply*.\n\n> Another quote.`;
const publication = { conversationId, publicationId: 'quote-copy-proof', shortText: text, fullText: text, links: [], replyTo: [] };
execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT OR REPLACE INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES(${quote(conversationId)},'quote-copy-proof',${quote(JSON.stringify(publication))},${quote(new Date().toISOString())});`]);
const page = rpc('neo.publication.read', { conversationId });
assert.equal(page.ok, true, `seeded publication must be readable: ${JSON.stringify(page)}`);
assert(page.items.some((item) => item.publicationId === publication.publicationId && item.fullText === text));
writeFileSync(`${run}/evidence/quote-copy-seed.json`, JSON.stringify(page, null, 2));
if (phase === 'seed-only') {
  console.log(JSON.stringify({ seededPublicationReadable: true, publicationId: publication.publicationId }));
  process.exit(0);
}
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const results = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 390, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
    await page.goto(`http://127.0.0.1:${port}/neo`);
    const body = page.locator('.neo-markdown').filter({ hasText: 'Hello friend' }).first();
    await body.locator('blockquote').first().waitFor();
    await body.locator('.hljs-keyword').first().waitFor();
    await body.locator('.katex').waitFor();
    const buttons = body.getByRole('button', { name: 'Copy quote', exact: true });
    const count = await buttons.count();
    assert.equal(count, phase === 'before' ? 0 : 3);
    if (phase !== 'before') {
      await buttons.first().focus();
      await page.keyboard.press('Enter');
      await body.getByRole('button', { name: 'Copy quote', exact: true }).first().getByText('Copied').waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `Hello friend and team.\n\nSecond paragraph.\n\n${code}\n\n${formula}\n\nNested reply.`);
      if (width === 390) await buttons.nth(1).tap(); else await buttons.nth(1).click();
      await page.waitForFunction(async () => await navigator.clipboard.readText() === 'Nested reply.');
      await page.waitForTimeout(1600);
      assert.equal(await body.getByText('Copied', { exact: true }).count(), 0);
      const geometry = await body.locator('blockquote').evaluateAll((quotes) => quotes.map((quote) => {
        const button = quote.querySelector('button').getBoundingClientRect();
        const bounds = quote.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(quote.querySelector('p'));
        const text = range.getBoundingClientRect();
        return { button: button.toJSON(), quote: bounds.toJSON(), text: text.toJSON(), padding: getComputedStyle(quote).paddingTop, background: getComputedStyle(quote).backgroundColor };
      }));
      for (const { button, quote, text } of geometry) {
        assert(button.x >= text.right && button.right <= quote.right + 1);
        assert(button.width >= 44 && button.height >= 44);
      }
      results.push({ theme, width, count, geometry, clipboard: 'plain text with paragraphs', keyboard: true, touch: width === 390 });
    } else results.push({ theme, width, count });
    await page.screenshot({ path: `${run}/evidence/quote-copy-${phase}-${theme}-${width}.png`, fullPage: true });
    await context.close();
  }
  writeFileSync(`${run}/evidence/quote-copy-${phase}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
