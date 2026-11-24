import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, sessionId, run] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const credential = readFileSync(0, 'utf8');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });

try {
  for (const [name, viewport, hasTouch] of [
    ['desktop', { width: 1280, height: 900 }, false],
    ['phone', { width: 390, height: 844 }, true],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch, locale: 'en-US' });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort()
    );
    await context.addCookies([{ name: 'hyperneo_device', value: credential, url: base }]);
    const page = await context.newPage();
    const screenshot = (suffix) =>
      page.screenshot({ path: join(run, `evidence/${name}-${suffix}.png`), animations: 'disabled' });
    await page.goto(`${base}/session/${sessionId}`);
    const more = page.getByTitle('More options');
    await more.waitFor({ timeout: 15000 });
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), hasTouch);
    const notice = page.getByText(/OXAP Codex.*cannot attach images.*Send text.*DeepSeek V4 Flash/);
    const checkIdle = async () => {
      const old = page.getByText(/This harness accepts text only/);
      if (await old.count()) await screenshot('baseline');
      assert.equal(await old.count(), 0, 'The composer displays a permanent restriction');
      assert.equal(await notice.count(), 0, 'The restriction appears before an image attempt');
    };
    await checkIdle();
    console.log(`${name}: no permanent restriction`);
    await screenshot('idle');
    await (hasTouch ? more.tap() : more.click());
    const attach = page.getByRole('button', { name: 'Attach image' });
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 1000 }).catch(() => null),
      hasTouch ? attach.tap() : attach.click(),
    ]);
    assert.equal(chooser, null);
    await notice.waitFor({ timeout: 5000 });
    assert.match(await notice.innerText(), /luna/i);
    const alert = page.getByRole('alert').filter({ has: notice });
    const bounds = await alert.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
    await screenshot('attach');
    console.log(`${name}: attach showed model guidance without opening a file picker`);
    if (!hasTouch) {
      for (const action of ['paste', 'drop']) {
        await page.reload();
        await more.waitFor({ timeout: 15000 });
        await checkIdle();
        const textarea = page.locator('textarea').first();
        await textarea.evaluate((element, type) => {
          const data = new DataTransfer();
          data.items.add(new File(['synthetic'], 'example.png', { type: 'image/png' }));
          const event = type === 'paste'
            ? new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true });
          element.dispatchEvent(event);
          if (!event.defaultPrevented) throw new Error(`${type} was not handled`);
        }, action);
        await notice.waitFor({ timeout: 5000 });
        console.log(`desktop: ${action} showed model guidance`);
      }
      await page.goto(`${base}/settings?tab=providers`);
      await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
      assert.equal(await page.getByLabel('Client', { exact: true }).inputValue(), 'oxap-codex');
      await page.getByLabel('Client executable').waitFor();
      await page.getByText('OXAP installation', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Save client' }).click();
      await page.getByText('Client saved', { exact: true }).waitFor();
      await screenshot('settings');
      console.log('desktop: OXAP provider settings label the client and confirm the save');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
