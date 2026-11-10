import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyOwnerHomeLabels(page, { run, base, width }) {
  const fixture = JSON.parse(await readFile(join(run, 'evidence/owner-home-fixture.json'), 'utf8'));
  const { home, path, url, outside, publicationId, text } = fixture;
  const calls = [], frames = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.method === 'operation.invoke') calls.push(message);
    });
    socket.on('framereceived', frame => frames.push(JSON.parse(String(frame.payload))));
  });
  await page.addInitScript(() => {
    window.__ownerCopies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.__ownerCopies.push(text) } });
  });
  const shot = async name => {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    await page.screenshot({ path: join(run, 'evidence', `owner-home-${name}-${width}.png`), scale: 'css' });
  };
  const close = async () => {
    const desktop = page.getByRole('button', { name: 'Close preview', exact: true });
    if (await desktop.isVisible()) await desktop.click();
    else {
      const dismiss = page.getByRole('button', { name: 'Dismiss preview', exact: true });
      if (await dismiss.count()) await dismiss.click({ position: { x: width / 2, y: 20 } });
    }
  };
  await writeFile(path, '# Owner file A\n');
  await page.goto(`${base}/neo`);
  const article = page.locator(`[data-message-ref="${publicationId}"]`);
  const inline = article.getByRole('link', { name: 'Open preview: ~/reports/current.md', exact: true }).first();
  await inline.waitFor();
  assert(frames.some(f => f.data?.system?.homeDirectory === home), 'real snapshot must supply the owning daemon home');
  assert.equal(await article.locator('pre').textContent(), `${path}\n`);
  assert.equal(await article.getByRole('link', { name: 'Named report', exact: true }).getAttribute('href'), url);
  assert.equal(await article.locator('a code').textContent(), '~/reports/space report.md');
  assert.equal(await article.locator('a strong').textContent(), '~/reports/space report.md');
  assert.equal(await article.getByTitle(outside, { exact: true }).count(), 1, 'a prefix sibling is not the owner home');
  const card = article.getByRole('button', { name: 'Open current file: current.md', exact: true });
  assert.equal(await card.getAttribute('title'), '~/reports/current.md');
  await article.hover();
  await article.getByTitle('Copy Neo’s message', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.__ownerCopies.at(-1)), text);
  await article.getByRole('button', { name: 'Copy quote', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__ownerCopies.at(-1)), path);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page must fit its viewport');
  await shot('message');
  await inline.click();
  await page.getByRole('heading', { name: 'Owner file A', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ask Neo about this file', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message Neo', exact: true });
  await editor.waitFor();
  assert.equal(await editor.inputValue(), `\`${path}\``);
  await editor.fill('');
  await close();
  await article.getByRole('link', { name: 'Open preview: ~/reports/space report.md', exact: true }).click();
  await page.getByRole('heading', { name: 'Encoded current file', exact: true }).waitFor();
  await close();
  await writeFile(path, '# Owner file B\n');
  await card.click();
  await page.getByRole('heading', { name: 'Owner file B', exact: true }).waitFor();
  await shot('preview');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name:'Download complete file',exact:true}).click()]);
  const downloaded = join(run, 'evidence', `owner-home-download-${width}.md`);
  await download.saveAs(downloaded);
  assert.equal(await readFile(downloaded, 'utf8'), '# Owner file B\n');
  await close();
  await unlink(path);
  await card.click();
  await page.getByText('This file is no longer there.', { exact: true }).waitFor();
  await shot('missing');
  await close();
  await page.getByRole('button', { name: 'Open preview: Synthetic notes', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic layout notes', exact: true }).waitFor();
  await close();
  const reads = calls.filter(c => c.data.name === 'file.reference.read').map(c => c.data.input);
  assert(reads.length >= 4);
  assert(reads.every(r => r.reference === path || r.reference === url));
  assert(reads.every(r => r.sourceMessageOrCard.kind === 'publication' && r.sourceMessageOrCard.id === publicationId));
  assert(reads.some(r => r.reference === url), 'encoded file URL must retain its exact identity');
  assert(!calls.some(c => c.data.name === 'artifact.file.register'));
  assert.deepEqual(errors, []);
  const result = { width, ownerHome: home, displayed: '~/reports/current.md', reads, copiesKeepOriginal: true, absoluteDraft: true, download: 'current B', editReopenMissing: true, prefixSiblingUnchanged: true, codeAndCustomTitleUnchanged: true, savedControl: true, pageErrors: errors };
  await writeFile(join(run, 'evidence', `owner-home-${width}.json`), JSON.stringify(result, null, 2));
  return result;
}
