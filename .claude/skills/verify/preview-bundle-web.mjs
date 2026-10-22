import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [phase, directory, port = '9417'] = process.argv.slice(2);
const run = realpathSync(directory);
const verify = fileURLToPath(new URL('.', import.meta.url));
assert.notEqual(port, '8399');
const rpc = (name, input) => {
 const out = execFileSync('bun', [join(verify, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' });
 const reply = JSON.parse(out).reply; assert(!reply.error, out); return reply.value ?? reply;
};
if (phase === 'seed') {
 assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
 execFileSync('bun', [join(verify, 'preview-bundle.ts'), run, 'seed'], { stdio: 'inherit' });
 process.exit(0);
}
const context = { kind: 'todo', id: 'todo' };
if (phase === 'prepare') {
 const opened = rpc('neo.open', {}); assert(opened.ok, JSON.stringify(opened));
 const register = (path, bundle) => {
  const result = rpc('artifact.file.register', { requestId: `bundle-${path}`, context, path, title: path === 'report.html' ? 'Bundled report' : path, ...(bundle ? { bundle } : {}) });
  assert(result.accepted, JSON.stringify(result)); return result.artifact;
 };
 const css = register('theme.css'); const image = register('chart.png');
 const bundle = [{ path: 'styles/theme.css', artifactId: css.artifactId }, { path: 'images/chart.png', artifactId: image.artifactId }];
 const ref = register('report.html', bundle);
 const prepared = rpc('artifact.file.html', { artifactId: ref.artifactId }); assert(prepared.accepted);
 const source = readFileSync(join(run, 'workspace', 'report.html'), 'utf8');
 assert.equal(Buffer.from(rpc('artifact.file.read', { artifactId: ref.artifactId }).data, 'base64').toString(), source);
 assert(prepared.document.includes('color:#13713d')); assert(prepared.document.includes('data:image/png;base64,'));
 assert(!prepared.document.includes('Unlisted')); assert(!prepared.document.includes('<script'));
 writeFileSync(join(run, 'evidence', 'html-viewer-refs.json'), JSON.stringify({ root: opened.sessionId, ref, ids: { bundle: ref.artifactId } }));
 writeFileSync(join(run, 'evidence', 'bundle-rpc.json'), JSON.stringify({ ref, prepared, bundle, source }, null, 2));
 writeFileSync(join(run, 'evidence', 'prepared-bundle.html'), prepared.document);
 for (const name of ['report.html', 'theme.css', 'chart.png']) renameSync(join(run, 'workspace', name), join(run, 'workspace', 'retained-' + name));
 assert.deepEqual(rpc('artifact.file.html', { artifactId: ref.artifactId }), prepared);
 console.log(JSON.stringify({ accepted: true, ref, sourceRetained: true })); process.exit(0);
}
const saved = JSON.parse(readFileSync(join(run, 'evidence', 'bundle-rpc.json'), 'utf8'));
if (phase === 'restart') {
 assert.deepEqual(rpc('artifact.file.html', { artifactId: saved.ref.artifactId }), saved.prepared);
 writeFileSync(join(run, 'evidence', 'bundle-restart.json'), JSON.stringify({ identicalAfterRestart: true, artifactId: saved.ref.artifactId }));
 process.exit(0);
}
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const attempts = [];
const evidence = {};
try {
 for (const width of [1280, 390]) {
  const browserContext = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' });
  await browserContext.route('**/*', route => {
   const url = route.request().url();
   if (url.startsWith(base) && !url.includes('/__bundle_probe__/')) return route.continue();
   attempts.push(url); return route.abort();
  });
  const page = await browserContext.newPage();
  try {
   await page.goto(`${base}/neo`);
   await page.getByRole('button', { name: 'Open preview: Bundled report' }).click();
   const frameElement = page.locator('iframe'); await frameElement.waitFor();
   assert.equal(await frameElement.getAttribute('sandbox'), '');
   const frame = page.frames().find(f => f !== page.mainFrame()); assert(frame);
   const title = frame.getByRole('heading', { name: 'Bundled report' }); await title.waitFor();
   assert.equal(await title.evaluate(node => getComputedStyle(node).color), 'rgb(19, 113, 61)');
   const chart = frame.getByAltText('Captured chart');
   assert.equal(await chart.evaluate(img => img.complete && img.naturalWidth > 0), true);
   assert((await chart.evaluate(img => getComputedStyle(img).backgroundImage)).includes('data:image/png;base64,'));
   assert.equal(await frame.locator('script,iframe,form,link').count(), 0);
   assert.equal(await frame.getByAltText('Unlisted').count(), 0);
   assert.equal(await frame.evaluate(() => { try { void parent.document.body; return 'accessible'; } catch { return 'denied'; } }), 'denied');
   await page.getByText('Scripts disabled', { exact: true }).waitFor();
   assert.equal(await frame.evaluate(() => window.__bundleProbe), undefined);
   assert.equal(await page.evaluate(() => window.__bundleProbe), undefined);
   assert.equal(browserContext.pages().length, 1);
   assert.deepEqual(attempts, []);
   await page.screenshot({ path: join(run, 'evidence', `bundle-preview-${width}.png`) });
   await page.getByRole('button', { name: 'Source', exact: true }).click();
   await page.locator('pre').waitFor(); assert.equal(await page.locator('pre').innerText(), saved.source);
   assert.equal(await page.locator('iframe').count(), 0);
   await page.screenshot({ path: join(run, 'evidence', `bundle-source-${width}.png`) });
   evidence[width] = { registeredCss: true, rasterAndCssBackground: true, opaqueSandbox: true, unlistedAssetDenied: true, exactOriginalSource: true };
  } catch (error) { await page.screenshot({ path: join(run, 'evidence', `bundle-failure-${width}.png`) }); throw error; }
  finally { await browserContext.close(); }
 }
} finally { await browser.close(); }
assert.deepEqual(attempts, []);
writeFileSync(join(run, 'evidence', 'bundle-web.json'), JSON.stringify({ widths: evidence, requestsOutsideHost: attempts }, null, 2));
console.log(JSON.stringify(evidence));
