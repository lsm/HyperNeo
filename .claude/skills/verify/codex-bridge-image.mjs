import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const { VERIFY_PORT, VERIFY_BROWSER, VERIFY_EVIDENCE, HYPERNEO_DATA_DIR } = process.env;
const mode = process.argv[2];
if (!VERIFY_PORT || !VERIFY_EVIDENCE || !HYPERNEO_DATA_DIR || !['valid', 'rejected'].includes(mode)) {
  throw new Error('Set VERIFY_PORT, VERIFY_EVIDENCE and HYPERNEO_DATA_DIR. Pass valid or rejected.');
}

const fixtures = {
  valid: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==',
  rejected:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAABlBMVEX/AAAAAAD2gwNJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
};
const base = `http://127.0.0.1:${VERIFY_PORT}`;
const rpc = fileURLToPath(new URL('./rpc.ts', import.meta.url));
const { reply } = JSON.parse(
  execFileSync('bun', [rpc, 'device.pair.create', '{"kind":"human","name":"Image proof"}'], {
    encoding: 'utf8',
  })
);

const browser = await chromium.launch({ executablePath: VERIFY_BROWSER });
try {
  const context = await browser.newContext();
  const pairing = await context.request.post(base + '/pair', {
    headers: { origin: base },
    data: { code: reply.code, name: 'Image proof' },
  });
  if (!pairing.ok()) throw new Error(`Pairing HTTP ${pairing.status()}`);

  const page = await context.newPage();
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.goto(base + '/sessions');
  await button('Choose model, client and thinking').click();
  await page.getByRole('button', { name: /^Model( & thinking)?,/ }).click();
  await button('GPT-6-Luna · Codex').click();
  if (await button('Back to settings').isVisible()) await button('Back to settings').click();
  if (!(await page.getByRole('button', { name: /^Client,/ }).count())) {
    await button('Choose model, client and thinking').click();
  }
  await page.getByRole('button', { name: /^Client,/ }).click();
  await button('Claude Code').click();
  if (await button('Close model settings').isVisible()) await button('Close model settings').click();
  await page
    .getByPlaceholder('Ask anything to start a new chat...')
    .fill('Reply exactly READY-CHECK. Use no tools.');
  await button('Start chat').click();
  await page.waitForURL(/\/session\//);
  const ready = page.locator('p').filter({ hasText: /^READY-CHECK$/ }).first();
  await ready.or(button('Skip')).first().waitFor();
  if (await button('Skip').isVisible()) await button('Skip').click();
  await ready.waitFor();

  await page.getByTitle('More options').click();
  const chooser = page.waitForEvent('filechooser');
  await button('Attach image').click();
  await (await chooser).setFiles({
    name: 'image-proof.png',
    mimeType: 'image/png',
    buffer: Buffer.from(fixtures[mode], 'base64'),
  });
  await button('Remove attachment').waitFor();
  const composer = page.getByPlaceholder('Ask or make anything...');
  await composer.fill('Identify the dominant color in the attached image. Reply with only the color.');
  await composer.press('Enter');

  const expected =
    mode === 'valid' ? page.getByText(/^red\.?$/i) : page.getByText(/could not parse image/i);
  const retries = page.getByText(/API RETRY/i);
  try {
    await expected.first().or(retries.first()).first().waitFor({ timeout: 45_000 });
    const results = await expected.count();
    const retryCount = await retries.count();
    console.log(`${mode}: expected result count=${results}, API retries=${retryCount}`);
    if (!results || retryCount) throw new Error('The image turn failed its expected outcome');
  } finally {
    await page.screenshot({ path: join(VERIFY_EVIDENCE, `${mode}.png`) });
  }
} finally {
  await browser.close();
}
