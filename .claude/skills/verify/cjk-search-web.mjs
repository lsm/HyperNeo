import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const evidence = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 874 } });
    const queries = new Map();
    const results = [];
    const errors = [];
    await page.route('**/*', route => { const url = new URL(route.request().url()); return url.hostname === '127.0.0.1' && url.port === port ? route.continue() : route.abort(); });
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**', socket => {
      const url = new URL(socket.url());
      if (url.hostname !== '127.0.0.1' || url.port !== port) { socket.close(); return; }
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const request = JSON.parse(String(raw));
        if (request.method === 'message.search') queries.set(request.id ?? request.requestId, request.data);
        server.send(raw);
      });
      server.onMessage(raw => {
        const reply = JSON.parse(String(raw));
        const input = queries.get(reply.requestId ?? reply.id);
        if (input) results.push({ input, reply });
        socket.send(raw);
      });
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/session/c0000000-0000-4000-8000-000000000054`);
      await page.getByText('Synthetic workspace', { exact: true }).first().waitFor();
      await page.keyboard.press('Meta+k');
      const input = page.getByTestId('command-palette-input');
      await input.waitFor();
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await page.getByPlaceholder('Search chats, messages, tasks…').waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await input.fill('构建');
      await page.getByText('Queries shorter than three characters match message titles only.', { exact: true }).waitFor();
      await page.getByText('历史构建版本', { exact: true }).first().waitFor();
      assert(results.some(row => row.input.query === '构建' && row.reply.data?.results?.some(hit => hit.messageId === 'cjk-old')));
      assert(!results.some(row => row.input.query === '构建' && row.reply.data?.results?.some(hit => hit.messageId === 'cjk-body-only')));
      const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      assert(layout.documentWidth <= width);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${run}/evidence/short-search-${width}.png`, animations: 'disabled' });
      evidence.push({ width, results, layout, errors, pass: true });
    } catch (error) {
      await page.screenshot({ path: `${run}/evidence/failure-${width}.png`, animations: 'disabled' });
      writeFileSync(`${run}/evidence/failure-${width}.json`, JSON.stringify({ errors, results, url: page.url(), body: await page.locator('body').innerText() }, null, 2));
      throw error;
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify({ evidence, pass: evidence.length === 2, phoneUI: 'unverified' }, null, 2));
}
