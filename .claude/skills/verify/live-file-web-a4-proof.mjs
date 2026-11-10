import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyLiveFilePage(page, {run, base, width, bun, cards = false}) {
  const {publicationId, files} = JSON.parse(await readFile(join(run, 'evidence/live-publication.json'), 'utf8'));
  assert(files.every(file => file.startsWith(join(run, 'workspace') + '/')));
  const [markdown, html, image, plain, unsupported] = files;
  const env = {HOME: join(run, 'home'), NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'), PATH: `${join(run, 'bin')}:${dirname(bun)}:/usr/bin:/bin`};
  const counts = () => JSON.parse(execFileSync(bun, [fileURLToPath(new URL('./live-file-web-a4-seed.ts', import.meta.url)), run, 'counts'], {env, encoding: 'utf8'}));
  const before = counts();
  await writeFile(markdown, '# Live A\n\nCurrent **Markdown** 中文.\n');
  await copyFile(join(run, 'image-a.png'), image);
  await writeFile(html, '<h1>Live HTML A</h1><p style="padding:24px;background:#d7eefa">Safe current HTML</p><script>window.unsafe=1</script><img src="https://example.invalid/remote.png"><a href="https://example.com/details">Details</a>');
  const operations = [];
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const call = JSON.parse(String(frame.payload)); if (call.method === 'operation.invoke' && /^(file\.reference|artifact\.)/.test(call.data?.name)) operations.push(call.data); } catch {}
  }));
  const shot = async name => {
    for (const dialog of await page.getByRole('dialog').all()) await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
    return page.screenshot({path: join(run, 'evidence', `live-${name}-${width}.png`)});
  };
  const tap = path => cards
    ? page.locator('article').filter({hasText:'Live source-bound files:'}).getByRole('button',{name:`Open current file: ${path.split('/').at(-1)}`,exact:true}).click()
    : page.getByRole('link', {name: `Open preview: ${path}`, exact: true}).click();
  const close = async path => {
    if (width >= 1120) await page.getByRole('button', {name: `Close ${path.split('/').at(-1)}`, exact: true}).click();
    else await page.getByRole('button', {name: 'Back', exact: true}).click();
  };
  try {
    await page.goto(`${base}/neo`);
    await page.getByText('Live source-bound files:', {exact: false}).waitFor();
    await tap(markdown);
    await page.getByRole('heading', {name: 'Live A', exact: true}).waitFor();
    await shot('markdown');
    if (width >= 1120) {
      await tap(html);
      await page.frameLocator('iframe[title="Static HTML preview"]').getByRole('heading', {name: 'Live HTML A'}).waitFor();
      await writeFile(markdown, '# Live B\n\nThe inactive file was edited.\n');
      await page.getByRole('tab', {name: 'current notes.md', exact: true}).click();
    } else {
      await close(markdown);
      await writeFile(markdown, '# Live B\n\nThe inactive file was edited.\n');
      await tap(markdown);
    }
    await page.getByRole('heading', {name: 'Live B', exact: true}).waitFor();
    assert.equal(await page.getByRole('heading', {name: 'Live A', exact: true}).count(), 0);
    await shot('edited');
    await close(markdown);
    await unlink(markdown);
    await tap(markdown);
    await page.getByText('This file is no longer there.', {exact: true}).waitFor();
    await shot('missing');
    await close(markdown);

    await tap(html);
    const frame = page.locator('iframe[title="Static HTML preview"]');
    await page.frameLocator('iframe[title="Static HTML preview"]').getByRole('heading', {name: 'Live HTML A'}).waitFor();
    assert.equal(await frame.getAttribute('sandbox'), '');
    assert.equal(await frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await frame.evaluate(node => node.contentDocument), null);
    await page.getByRole('button', {name: 'Details', exact: true}).click();
    await page.getByText('https://example.com/details', {exact: true}).waitFor();
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await shot('html');
    await close(html);
    await writeFile(html, '<h1>Live HTML B</h1>');
    await tap(html);
    await page.frameLocator('iframe[title="Static HTML preview"]').getByRole('heading', {name: 'Live HTML B'}).waitFor();
    await close(html);

    await tap(image);
    const raster = page.getByRole('img', {name: 'current.png', exact: true});
    await raster.waitFor();
    await page.waitForFunction(alt => { const node = [...document.images].find(node => node.alt === alt); return node?.complete && node.naturalWidth > 0; }, image.split('/').at(-1));
    await raster.evaluate(node => node.decode());
    assert.equal((await raster.evaluate(node => [node.naturalWidth, node.naturalHeight])).join(','), '256,160');
    const color = () => raster.evaluate(node => { const canvas = document.createElement('canvas'); canvas.width=256; canvas.height=160; const ctx=canvas.getContext('2d'); ctx.drawImage(node,0,0); return Array.from(ctx.getImageData(0,0,1,1).data); });
    assert.equal((await color()).join(','), '30,80,210,255');
    await shot('image');
    await close(image);
    await copyFile(join(run, 'image-b.png'), image);
    await tap(image);
    await raster.waitFor();
    await page.waitForFunction(alt => { const node = [...document.images].find(node => node.alt === alt); return node?.complete && node.naturalWidth > 0; }, image.split('/').at(-1));
    await raster.evaluate(node => node.decode());
    assert.equal((await color()).join(','), '180,80,30,255');
    await shot('image-edited');
    await close(image);

    await tap(plain);
    await page.getByRole('button', {name: 'Download complete file', exact: true}).waitFor();
    const expected = Buffer.from('Plain current B\n' + 'updated 中文\n'.repeat(30000));
    await writeFile(plain, expected);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Download complete file', exact: true}).click()]);
    const saved = join(run, 'evidence', `download-${width}.txt`);
    await download.saveAs(saved);
    assert((await readFile(saved)).equals(expected));
    await close(plain);
    const publication = page.locator('article').filter({hasText:'Live source-bound files:'});
    assert((await publication.innerText()).includes(unsupported));
    assert.equal(await publication.getByRole('link', {name: `Open preview: ${unsupported}`, exact: true}).count(), 0);
    assert.equal(await publication.getByRole('button', {name: `Open current file: ${unsupported.split('/').at(-1)}`, exact: true}).count(), 0);
    assert.deepEqual(counts(), before, 'Live previews must create no registry rows');
    assert(operations.every(call => call.name === 'file.reference.read'));
    assert(operations.every(call => call.input.sourceMessageOrCard.kind === 'publication' && call.input.sourceMessageOrCard.id === publicationId));
    assert(operations.some(call => call.input.offset > 0 && /^[a-f0-9]{64}$/.test(call.input.version)));
    const liveReads = operations.length;
    const card = page.getByRole('button', {name: 'Open preview: Synthetic notes', exact: true});
    await card.click();
    await page.getByRole('heading', {name: 'Synthetic layout notes'}).waitFor();
    if (width >= 1120) await page.getByRole('button', {name: 'Close Synthetic notes', exact: true}).click();
    else await page.keyboard.press('Escape');
    await page.getByText('https://github.com/lsm/HyperNeo/pull/42', {exact: true}).click();
    await page.getByRole('button', {name: /docs\/report\.md/}).click();
    await page.getByText('commit aaaaaaa', {exact: false}).waitFor();
    await shot('git');
    await page.getByRole('button', {name: 'Back', exact: true}).click();
    await page.getByRole('heading', {name: 'Synthetic design PR',exact:true}).waitFor();
    await page.getByRole('button', {name: 'Back', exact: true}).click();
    assert(operations.some(call => call.name === 'artifact.file.get'));
    assert(operations.some(call => call.name === 'artifact.reference.resolve' && call.input.file?.headSha === 'a'.repeat(40)));
    assert.deepEqual(failures, []);
    const observed = {width, liveReads, sourceBound: true, currentMarkdown: true, currentHtml: true, currentImage: true, deletedMissing: true, noRegistryWrites: true, downloadBytes: expected.length, downloadSha256: createHash('sha256').update(expected).digest('hex'), legacyAndGit: true, failures};
    await writeFile(join(run, 'evidence', `observed-${width}.json`), JSON.stringify(observed, null, 2));
    return observed;
  } catch (error) {
    await shot('failure');
    throw error;
  }
}

if (typeof process !== 'undefined' && process.argv[1] === fileURLToPath(import.meta.url)) {
  const {createRequire} = await import('node:module');
  const {chromium} = createRequire(import.meta.url)('playwright');
  const [run, port] = process.argv.slice(2);
  assert.notEqual(port, '8399');
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({headless: true, ...(process.env.VERIFY_BROWSER ? {executablePath: process.env.VERIFY_BROWSER} : {})});
  const offOrigin = [];
  try {
    for (const width of [1280,390]) {
      const context = await browser.newContext({viewport: {width,height:844}, locale:'en-US', ...(width === 390 ? {isMobile:true,deviceScaleFactor:1} : {})});
      try {
        await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : (offOrigin.push(route.request().url()), route.abort()));
        await verifyLiveFilePage(await context.newPage(), {run,base,width,bun:process.env.VERIFY_BUN ?? 'bun'});
      } finally { await context.close(); }
    }
    assert.equal(offOrigin.length,0);
    console.log('PASS: current web file previews at desktop and phone widths; no off-origin requests');
  } finally { await browser.close(); }
}
