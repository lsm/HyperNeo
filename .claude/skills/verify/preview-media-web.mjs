import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const [phase, directory, port = '9397'] = process.argv.slice(2);
const run = realpathSync(directory);
assert.notEqual(port, '8399');
const verify = fileURLToPath(new URL('.', import.meta.url));
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGN41mNDFcQwatCoQaMGjRo0atCoQQNvEADxaMeuOCcmmgAAAABJRU5ErkJggg==';
if (phase === 'seed') {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
  execFileSync('bun', [join(verify, 'preview-register.ts'), run, 'seed'], { stdio: 'inherit' });
  writeFileSync(join(run, 'workspace', 'report.json'), '{"title":"Synthetic JSON","markup":"<script>window.__mediaSentinel=1</script>"}');
  writeFileSync(join(run, 'workspace', 'large.log'), `HEAD synthetic log\n${'line 0123456789\n'.repeat(80000)}TAIL synthetic log`);
  writeFileSync(join(run, 'workspace', 'chart.png'), Buffer.from(pixel, 'base64'));
  const big = Buffer.from(pixel, 'base64'); big.writeUInt32BE(100000, 16); big.writeUInt32BE(100000, 20);
  writeFileSync(join(run, 'workspace', 'oversized.png'), big);
  process.exit(0);
}
const rpc = (name, input) => {
  const out = execFileSync('bun', [join(verify, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' });
  const reply = JSON.parse(out).reply; assert(!reply.error, out); return reply.value ?? reply;
};
const ids = {};
for (const name of ['report.json', 'large.log', 'chart.png', 'oversized.png']) {
  const result = rpc('artifact.file.register', { requestId: `media-${name}`, context: { kind: 'todo', id: 'todo' }, path: name, title: name });
  assert(result.accepted, JSON.stringify(result)); ids[name] = result.artifact.artifactId;
}
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`; const offOrigin = []; const observed = {};
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(base)) return route.continue();
      offOrigin.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    const open = name => page.goto(`${base}/neo?artifact=${ids[name]}`);
    await open('report.json'); await page.locator('pre').waitFor();
    assert.equal(await page.locator('pre').innerText(), JSON.stringify(JSON.parse(readFileSync(join(run, 'workspace', 'report.json'))), null, 2));
    assert.equal(await page.evaluate(() => window.__mediaSentinel), undefined);
    await page.getByRole('button', { name: 'Copy visible' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator('pre').innerText());
    await page.screenshot({ path: join(run, 'evidence', `media-json-${width}.png`) });
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await page.locator('pre').innerText(), readFileSync(join(run, 'workspace', 'report.json'), 'utf8'));
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await open('chart.png'); const image = page.getByRole('img', { name: 'chart.png' });
    await image.waitFor(); await page.waitForFunction(() => document.querySelector('section img')?.naturalWidth === 24);
    await page.getByRole('button', { name: 'Original size' }).click();
    assert.equal(await page.getByRole('button', { name: 'Original size' }).getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: join(run, 'evidence', `media-image-${width}.png`) });
    await open('oversized.png'); await page.getByText('Image preview exceeds 32 MB or 16 megapixels. Download the complete file.').waitFor();
    assert.equal(await page.locator('section img').count(), 0);
    await open('large.log'); await page.locator('pre').waitFor();
    const text = await page.locator('pre').innerText(); assert(text.startsWith('HEAD synthetic log')); assert(text.endsWith('TAIL synthetic log'));
    const source = readFileSync(join(run, 'workspace', 'large.log'));
    await page.getByText(`${source.length - 262144} bytes omitted. Showing head and tail. Download the complete file.`).waitFor();
    await page.screenshot({ path: join(run, 'evidence', `media-log-${width}.png`) });
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download complete file' }).click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'large.log');
    const target = join(run, 'evidence', `large-${width}.log`); await download.saveAs(target);
    const hash = data => createHash('sha256').update(data).digest('hex');
    assert.equal(hash(readFileSync(target)), hash(source));
    observed[width] = { formattedJson: true, inertMarkup: true, copy: true, imagePixels: 576, oversizedRefused: true, omittedBytes: source.length - 262144, downloadBytes: source.length, sha256: hash(source) };
    await context.close();
  }
} finally { await browser.close(); }
assert.deepEqual(offOrigin, []);
writeFileSync(join(run, 'evidence', 'media-web.json'), JSON.stringify({ ids, observed, offOrigin }, null, 2));
console.log(JSON.stringify(observed));
