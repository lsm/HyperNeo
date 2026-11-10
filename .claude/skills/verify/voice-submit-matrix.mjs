import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const run = process.argv[2];
const fixture = JSON.parse(readFileSync(`${run}/browser.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${run}/tone.wav`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  permissions: ['microphone'],
  locale: 'en-US',
});
const page = await context.newPage();
const results = [];
const call = async (path, data) => {
  const response = await page.request.fetch(
    `${fixture.asr}/${path}`,
    data ? { method: 'POST', data } : {}
  );
  assert(response.ok());
  return response.json();
};
const wait = async (read, label) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label);
};
const combinations = [
  { name: 'quote', quote: true },
  { name: 'plain' },
  { name: 'image', image: true },
  { name: 'file', file: true },
  { name: 'quote-image', quote: true, image: true },
  { name: 'quote-file', quote: true, file: true },
  { name: 'quote-image-file', quote: true, image: true, file: true },
];
const actions = ['recording-send', 'asr-pending-send', 'stop-then-send', 'asr-pending-enter'];
const cases =
  fixture.phase === 'before'
    ? [{ ...combinations[0], action: actions[0] }]
    : ['batch', 'streaming'].flatMap((mode) =>
        combinations.flatMap((item) =>
          [...actions, 'stop-only'].map((action) => ({ ...item, action, mode }))
        )
      );
process.once('SIGTERM', () => {
  void browser.close().finally(() => process.exit(143));
});
try {
  const paired = await context.request.post(`${fixture.base}/pair`, {
    headers: { origin: fixture.base },
    data: { code: fixture.code, name: 'Synthetic voice browser' },
  });
  assert.equal(paired.status(), 200);
  assert(!('credential' in (await paired.json())));
  await page.goto(`${fixture.base}/neo`);
  const form = page.locator('form.neo-composer-input');
  for (const item of cases) {
    if (results.length === 20) await page.waitForTimeout(61_000);
    const token = `voice-${results.length}-${item.name}-${item.action}`;
    await call('mode', { streaming: item.mode === 'streaming' });
    await page.reload();
    const prefix = `Typed ${token}`;
    const final = `Spoken ${token}`;
    await form.locator('textarea').waitFor();
    await form.locator('textarea').fill(prefix);
    if (item.quote)
      await page
        .locator(`[data-message-ref="${fixture.publicationId}"]`)
        .getByRole('button', { name: 'Reply to Neo’s message' })
        .click();
    const files = [];
    if (item.image)
      files.push({
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4doAAAAASUVORK5CYII=',
          'base64'
        ),
      });
    if (item.file)
      files.push({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(`File ${token}`),
      });
    for (const file of [...files]) files.push({ ...file, name: `second-${file.name}` });
    if (files.length) await form.locator('input[type=file]').setInputFiles(files);
    await call('arm', { id: token, text: final });
    await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
    const stop = form.getByRole('button', {
      name: 'Stop recording and keep the text as a draft',
      exact: true,
    });
    await stop.waitFor();
    const submit = form.locator('button[type=submit]');
    await wait(
      async () =>
        (await stop.isEnabled()) &&
        (await submit.getAttribute('aria-label')) === 'Stop recording and send the message',
      'Recorder must finish starting before speech'
    );
    await page.waitForTimeout(450);
    if (item.action === 'recording-send') await submit.click();
    else {
      if (item.action === 'stop-then-send')
        await stop.evaluate((button) => {
          button.click();
          button.closest('form').querySelector('button[type=submit]').click();
        });
      else {
        await stop.click();
        await wait(async () => (await call('stats')).held, 'ASR must receive real captured audio');
        if (item.action === 'asr-pending-enter') {
          await submit.focus();
          await submit.press('Enter');
        } else if (item.action !== 'stop-only') await submit.click();
      }
    }
    await wait(async () => (await call('stats')).held, 'ASR final transcript must remain held');
    const before = await call('observed');
    assert.equal(
      before.receipts.filter((row) => JSON.stringify(row.input).includes(token)).length,
      0
    );
    await call('release');
    await form.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
    await form.locator('textarea').waitFor();
    await page.waitForTimeout(150);
    if (item.action === 'stop-only') {
      const draftOnly = await form.locator('textarea').inputValue();
      assert(draftOnly.includes(prefix) && draftOnly.includes(final), 'Stop preserves all words');
      const held = await call('observed');
      assert.equal(
        held.receipts.filter((row) => JSON.stringify(row.input).includes(token)).length,
        0
      );
      await submit.click();
      await wait(
        async () =>
          (await call('observed')).receipts.some((row) =>
            JSON.stringify(row.input).includes(token)
          ),
        'Ordinary Send gets a receipt'
      );
      await wait(
        async () => (await form.locator('textarea').inputValue()) === '',
        'Ordinary Send clears draft'
      );
    }
    const seen = await call('observed');
    const sent = seen.receipts.filter((row) => JSON.stringify(row.input).includes(token));
    const durable = seen.durable.filter((row) => JSON.stringify(row).includes(token));
    const input = sent[0]?.input;
    const serialized = JSON.stringify(input ?? {});
    const draft = await form.locator('textarea').inputValue();
    const result = {
      case: item.name,
      mode: item.mode ?? 'batch',
      action: item.action,
      asr: await call('stats'),
      sends: sent.length,
      durable: durable.length,
      draft,
      prefix: serialized.includes(prefix),
      transcript: serialized.includes(final),
      quote: !item.quote || serialized.includes(fixture.publicationId),
      image:
        !item.image ||
        (Array.isArray(input?.content) &&
          input.content.filter(
            (part) =>
              part.type === 'image' &&
              part.source.data ===
                files.find((file) => file.mimeType === 'image/png').buffer.toString('base64')
          ).length === 2),
      file:
        !item.file ||
        (serialized.includes(`File ${token}`) &&
          serialized.includes('notes.txt') &&
          serialized.includes('second-notes.txt')),
    };
    result.pass =
      result.asr.route === result.mode &&
      result.asr.bytes > 0 &&
      result.sends === 1 &&
      result.durable === 1 &&
      draft === '' &&
      result.prefix &&
      result.transcript &&
      result.quote &&
      result.image &&
      result.file;
    results.push(result);
    writeFileSync(`${run}/evidence/matrix.json`, JSON.stringify(results, null, 2));
    const latest = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
    if (await latest.count()) await latest.click();
    await page.screenshot({ path: `${run}/evidence/${token}.png` });
    console.log(JSON.stringify(result));
    if (fixture.phase === 'before')
      assert(result.pass, 'One Send during quoted speech must submit once after final ASR');
    await form.locator('textarea').fill('');
    const quote = form.getByRole('button', { name: 'Remove reply', exact: true });
    if (await quote.count()) await quote.click();
    while (await form.locator('[data-attachment] button').count())
      await form.locator('[data-attachment] button').first().click();
  }
  assert(
    results.every((result) => result.pass),
    'Every composition/send path must pass'
  );
} catch (error) {
  writeFileSync(
    `${run}/evidence/failure.json`,
    JSON.stringify(
      { stats: await call('stats'), text: await page.locator('body').innerText() },
      null,
      2
    )
  );
  await page.screenshot({ path: `${run}/evidence/failure.png` });
  throw error;
} finally {
  writeFileSync(`${run}/evidence/matrix.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
