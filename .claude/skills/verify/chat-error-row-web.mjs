import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pairMessageCopyBrowser } from './neo-whole-message-copy-web.mjs';

const [run, port, evidence] = process.argv.slice(2);
assert(run && evidence && Number(port) > 0 && Number(port) !== 8399);
const pairBase = `http://127.0.0.1:${port}`;
const { worker } = JSON.parse(await readFile(join(run, 'evidence/error-workflow-seed.json')));
const pairing = JSON.parse(
  execFileSync(
    'bun',
    [
      '.claude/skills/verify/rpc.ts',
      'device.pair.create',
      JSON.stringify({ kind: 'human', name: 'Synthetic chat error browser' }),
    ],
    { env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') } }
  )
);
assert(pairing.reply.code, 'expected a disposable pairing code');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const results = [];
await mkdir(evidence, { recursive: true });
try {
  const storageState = await pairMessageCopyBrowser(browser, { pairBase, pairCode: pairing.reply.code });
  for (const [layout, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    const hasTouch = layout === 'phone';
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        storageState,
        viewport: { width, height },
        isMobile: hasTouch,
        hasTouch,
        colorScheme,
        locale: 'en-US',
      });
      await context.route('**/*', (route) =>
        route.request().url().startsWith(pairBase) ? route.continue() : route.abort()
      );
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      await page.goto(`${pairBase}/session/${worker}`);
      const chat = page.getByTestId('chat-container');
      const title = chat.getByTestId('chat-header-title');
      const request = chat.getByText('Synthetic request that failed', { exact: true });
      const error = chat.getByText('Synthetic error report', { exact: true });
      const messages = chat.locator('[data-messages-container]');
      await title.waitFor();
      await request.waitFor();
      await error.waitFor();
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, colorScheme);
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), hasTouch);
      await request.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `${layout}-${colorScheme}.png`), animations: 'disabled' });

      const inline = await messages.getByText('Synthetic error report', { exact: true }).count() === 1;
      const afterRequest = await request.evaluate(
        (element) => Boolean(element.compareDocumentPosition(
          [...document.querySelectorAll('p')].find((paragraph) => paragraph.textContent === 'Synthetic error report')
        ) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      const errorBox = await error.boundingBox();
      const headerBox = await title.boundingBox();
      const aboveTitle = errorBox.y < headerBox.y;
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      const use = (button) => hasTouch ? button.tap() : button.click();
      await use(chat.getByRole('button', { name: /^(View )?Details$/ }));
      const dialog = page.getByRole('dialog');
      await dialog.getByText(/technical details/i).waitFor();
      await use(dialog.getByRole('button', { name: 'Close', exact: true }));
      await page.reload();
      await error.waitFor();

      await messages.evaluate((element) => { element.scrollTop = 0; });
      const scrollsWithMessages = await error.evaluate((element) => {
        const scroller = document.querySelector('[data-messages-container]');
        return element.getBoundingClientRect().top >= scroller.getBoundingClientRect().bottom;
      });
      await use(chat.getByRole('button', { name: /^Dismiss( error)?$/i }));
      await error.waitFor({ state: 'hidden' });
      results.push({ layout, colorScheme, inline, afterRequest, aboveTitle, fits, scrollsWithMessages, details: true, reload: true, dismiss: true });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(join(evidence, 'observed.json'), JSON.stringify(results, null, 2));
}
assert.equal(results.length, 4);
for (const result of results) {
  assert(result.inline && result.afterRequest && !result.aboveTitle && result.fits && result.scrollsWithMessages, JSON.stringify(result));
}
console.log(`PASS: ${results.length} layouts verified Details, Dismiss, reload, and scroll placement.`);
