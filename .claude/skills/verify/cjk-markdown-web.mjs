import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [run, port, phase, evidence] = process.argv.slice(2);
assert.notEqual(port, '8399');
assert(['before', 'after'].includes(phase));
mkdirSync(evidence, { recursive: true });
const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'artifact.file.register', JSON.stringify({
  requestId: crypto.randomUUID(), context: { kind: 'todo', id: 'todo' }, path: 'report.md', title: 'Synthetic CJK Markdown',
})], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' })).reply;
const value = reply.value ?? reply;
assert(value.accepted, JSON.stringify(reply));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const results = [];
try {
  for (const width of [1280, 390]) {
    for (const [surface, path] of [['artifact', `/neo?artifact=${value.artifact.artifactId}`], ['chat', '/session/40000000-0000-4000-8000-000000008643']]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const base = `http://127.0.0.1:${port}`;
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base + path);
      const prose = page.locator('.prose').filter({ hasText: '共可达' }).first();
      try { await prose.locator('p').first().waitFor({ timeout: 15000 }); } catch (error) { await page.screenshot({ path: `${evidence}/debug-${surface}.png` }); console.log(await page.locator('body').innerText()); throw error; }
      const strong = await prose.locator('strong').allTextContents();
      const italic = await prose.locator('em').allTextContents();
      const text = await prose.innerText();
      results.push({ surface, width, strong, italic, text });
      await page.screenshot({ path: `${evidence}/${phase}-${surface}-${width}.png`, fullPage: true });
      if (phase === 'after') {
        assert.deepEqual(strong, ['$38.43/月', '下一项', '「重点」', '链接', '$38.43/月']);
        assert.deepEqual(italic, ['「強調」']);
        assert.equal(await prose.locator('code').innerText(), '共可达**$38.43/月**，');
        assert(text.includes('**价格** $38.43 and $50'));
        assert.equal(await prose.locator('br').count(), 1);
      } else assert.notDeepEqual(strong, ['$38.43/月', '下一项', '「重点」', '链接', '$38.43/月']);
      await page.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(`${evidence}/${phase}.json`, JSON.stringify({ run, port, results }, null, 2));
}
console.log(`PASS: ${phase} artifact and chat at both widths`);
