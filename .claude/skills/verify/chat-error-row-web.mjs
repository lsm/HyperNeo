import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pairMessageCopyBrowser } from './neo-whole-message-copy-web.mjs';

const [run, port, evidence] = process.argv.slice(2);
assert(run && evidence && Number(port) > 0 && Number(port) !== 8399);
const pairBase = `http://127.0.0.1:${port}`;
const { cases, raw } = JSON.parse(await readFile(join(run, 'evidence/chat-error-cases.json')));
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
  for (const fixture of cases) {
    const sharedChat = fixture.name !== 'neo' && fixture.name !== 'space';
    const layouts = sharedChat
      ? [['desktop', 1280, 900, 'light'], ['desktop', 1280, 900, 'dark'],
         ['phone', 390, 844, 'light'], ['phone', 390, 844, 'dark']]
      : [['desktop', 1280, 900, 'light']];
    for (const [layout, width, height, colorScheme] of layouts) {
      const hasTouch = layout === 'phone';
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
      await page.goto(`${pairBase}${fixture.path}`);
      const transcript = fixture.name === 'neo'
        ? page.getByRole('region', { name: 'Conversation with Neo' })
        : fixture.name === 'space'
          ? page.getByTestId('space-task-unified-thread')
          : page.locator('[data-messages-container]');
      const request = transcript.getByText(fixture.request, { exact: true });
      const title = transcript.getByText(fixture.title, { exact: true });
      const cause = transcript.getByText(fixture.cause, { exact: true });
      await request.waitFor();
      await title.waitFor();
      await cause.waitFor();
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, colorScheme);
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), hasTouch);
      const heading = await title.evaluate((el) => ({
        bold: Number(getComputedStyle(el).fontWeight) >= 600,
        fits: el.scrollWidth <= el.clientWidth,
      }));
      assert(heading.bold && heading.fits, JSON.stringify(heading));
      assert(await cause.evaluate((el) => el.scrollWidth <= el.clientWidth));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(await title.evaluate(
        (element, requestElement) =>
          Boolean(requestElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
        await request.elementHandle()
      ));
      assert.equal(await transcript.getByText(raw, { exact: false }).count(), 0);
      await cause.scrollIntoViewIfNeeded();
      const screenshot = sharedChat ? `${fixture.name}-${layout}-${colorScheme}.png` : `${fixture.name}.png`;
      await page.screenshot({ path: join(evidence, screenshot), animations: 'disabled' });

      const use = (button) => hasTouch ? button.tap() : button.click();
      if (sharedChat) {
        const chat = page.getByTestId('chat-container');
        const header = chat.getByTestId('chat-header-title');
        assert((await title.boundingBox()).y > (await header.boundingBox()).y);
        await use(transcript.getByRole('button', { name: 'Details', exact: true }));
        const dialog = page.getByRole('dialog');
        await use(dialog.getByRole('button', { name: /technical details/i }));
        await dialog.getByText(raw, { exact: false }).waitFor();
        await use(dialog.getByRole('button', { name: 'Close', exact: true }));
        await page.reload();
        await request.waitFor();
        await cause.waitFor();
        await page.waitForFunction(() => {
          const scroller = document.querySelector('[data-messages-container]');
          return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 5;
        });
        await transcript.evaluate((element) => {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000 }));
          element.scrollTop = 0;
        });
        await page.waitForFunction((element) => {
          const scroller = element.closest('[data-messages-container]');
          return element.getBoundingClientRect().top >= scroller.getBoundingClientRect().bottom;
        }, await title.elementHandle());
        await use(transcript.getByRole('button', { name: 'Dismiss error' }));
        await title.waitFor({ state: 'hidden' });
      }
      if (fixture.name === 'space') {
        await transcript.getByRole('button', { name: 'Re-authenticate Anthropic' }).waitFor();
      }
      results.push({
        case: fixture.name, layout, colorScheme, title: fixture.title, cause: fixture.cause,
        screenshot, detailsDismissReloadAndScroll: sharedChat,
      });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(join(evidence, 'observed.json'), JSON.stringify(results, null, 2));
}
assert.equal(results.length, 14);
console.log(`PASS: ${results.length} layouts verified inline error summaries, including Neo and Space.`);
