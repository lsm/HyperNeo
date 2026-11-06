import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const [port, out] = process.argv.slice(2);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER,
});
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    locale: 'en-US',
    reducedMotion: 'no-preference',
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/neo`);
  const input = page.locator('textarea').first();
  await input.waitFor();
  for (let i = 0; i < 7; i++) {
    const count = await page.locator('[data-public-entry].neo-message-user').count();
    await input.fill(`History ${i}\n` + 'Synthetic history line\n'.repeat(8));
    await input.press('Enter');
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-public-entry].neo-message-user').length > n,
      count
    );
    await page.waitForTimeout(600);
  }
  await page
    .locator('[data-public-entry].neo-message-user')
    .first()
    .getByRole('button', { name: 'Reply to your message', exact: true })
    .click();
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    c.getContext('2d').fillRect(0, 0, 120, 80);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles([
      { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('File body') },
    ]);
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="Attachments"] > li').length === 2
  );
  await input.fill('Read this file');
  const count = await page.locator('[data-public-entry].neo-message-user').count();
  await input.press('Enter');
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-public-entry].neo-message-user').length > n,
    count
  );
  await page.waitForTimeout(1900);
  await page.evaluate(() => {
    window.readerEvents = [];
    const measure = () => {
      const cards = [
        ...document.querySelectorAll('[data-public-entry].neo-message-user button'),
      ].filter((e) => e.getAttribute('aria-label') === window.readerLabel);
      const card = cards.at(-1),
        r = card?.getBoundingClientRect();
      return {
        card: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        active: document.activeElement?.tagName,
        form: document.querySelector('form.neo-composer-input')?.className,
        dialogs: document.querySelectorAll('[role=dialog]').length,
      };
    };
    window.readerMeasure = measure;
    for (const type of ['pointerdown', 'pointerup', 'click', 'focusin', 'focusout'])
      document.addEventListener(
        type,
        (e) =>
          window.readerEvents.push({
            type,
            target: e.target.tagName,
            label: e.target.closest('button')?.getAttribute('aria-label'),
            ...measure(),
          }),
        true
      );
  });
  const observations = [];
  const row = page.locator('[data-public-entry].neo-message-user').last();
  for (const kind of ['file', 'photo']) {
    await input.focus();
    await page.waitForFunction(() =>
      document.querySelector('form.neo-composer-input')?.classList.contains('is-focused')
    );
    const label = kind === 'file' ? 'Open file: notes.txt' : 'Open attached photo 1';
    await page.evaluate((label) => {
      window.readerLabel = label;
      window.readerEvents = [];
    }, label);
    const before = await page.evaluate(() => window.readerMeasure());
    await page.screenshot({ path: join(out, `${kind}-before.png`) });
    const button = row.getByRole('button', { name: label, exact: true });
    await button.click({ delay: 100 });
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => ({
      events: window.readerEvents,
      after: window.readerMeasure(),
    }));
    observations.push({ kind, before, ...result });
    writeFileSync(join(out, 'reader.json'), JSON.stringify(observations, null, 2));
    await page.screenshot({ path: join(out, `${kind}-after.png`) });
    assert.equal(result.after.dialogs, 1, 'Reader did not open on a normal held pointer click');
    const released = result.events.find((event) => event.type === 'pointerup');
    assert.equal(released?.label, label, 'Pointer-up missed its reader trigger');
    assert(Math.abs(released.card.y - before.card.y) < 1, 'Reader moved before pointer-up');
    const dialog = page.getByRole('dialog', {
      name: kind === 'file' ? 'notes.txt' : 'Attached photo 1',
      exact: true,
    });
    await dialog.waitFor();
    if (kind === 'file') assert.equal(await dialog.locator('pre').textContent(), 'File body');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await button.focus();
    await button.press('Enter');
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1, 'Keyboard activation lost its reader');
    await page.screenshot({ path: join(out, `${kind}-keyboard.png`) });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  console.log(
    'PASS: 100ms held file/photo clicks retain their target through pointer-up; both readers also open by keyboard'
  );
} finally {
  await browser.close();
}
