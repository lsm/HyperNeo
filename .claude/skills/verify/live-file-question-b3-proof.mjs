import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export async function verifyFileQuestion(page, { run, base, width, bun }) {
  const fixture = JSON.parse(await readFile(join(run, 'evidence/file-card-sources.json'), 'utf8'));
  const path = fixture.files[0];
  const inventory = async () => {
    const rows = execFileSync(bun, [fileURLToPath(new URL('./live-file-web-a4-seed.ts', import.meta.url)), run, 'counts'], {
      env: { HOME: join(run, 'home'), HYPERNEO_DATA_DIR: join(run, 'data'), NODE_ENV: 'test', PATH: `${join(run, 'bin')}:${dirname(bun)}:/usr/bin:/bin` },
      encoding: 'utf8',
    }).trim();
    const store = join(run, 'data/artifacts/blobs');
    const blobs = await Promise.all((await readdir(store)).sort().map(async name => [name, createHash('sha256').update(await readFile(join(store, name))).digest('hex')]));
    return { rows, blobs };
  };
  const before = await inventory();

  const calls = [], replies = new Map(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.method === 'operation.invoke') calls.push(message);
    });
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'RSP') replies.set(message.requestId ?? message.id, message);
    });
  });
  const shot = async name => {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    await page.screenshot({ path: join(run, 'evidence', `file-question-${name}-${width}.png`), scale: 'css' });
  };
  const ask = page.getByRole('button', { name: 'Ask Neo about this file', exact: true });
  const editor = page.getByRole('textbox', { name: 'Message Neo', exact: true });
  const question = page.locator(`[data-ask-question="${fixture.questionId}"]`);
  const showQuestion = async () => {
    if (width >= 1120) {
      const work = page.getByRole('tab', { name: /Your work/ });
      if (await work.count()) await work.click();
    } else {
      const back = page.getByRole('button', { name: 'Back', exact: true });
      if (await back.isVisible()) await back.click();
      else if (await page.getByRole('button', { name: 'Dismiss preview', exact: true }).count())
        await page.getByRole('button', { name: 'Dismiss preview', exact: true }).click({ position: { x: width / 2, y: 20 } });
      if (!await question.isVisible()) await page.getByRole('button', { name: /Your work, .*need your attention/ }).click();
    }
    await question.waitFor({ state: 'visible' });
  };
  await writeFile(path, '# Ask current file A\n');
  await page.goto(`${base}/neo`);
  await page.getByText('Live source-bound files:', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Open preview: Synthetic notes', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic layout notes', exact: true }).waitFor();
  assert.equal(await ask.count(), 0, 'saved attachments retain their separate preview');
  await showQuestion();
  const card = question.getByRole('button', { name: 'Open current file: current notes.md', exact: true });
  await card.click();
  await page.getByRole('heading', { name: 'Ask current file A', exact: true }).waitFor();
  await ask.waitFor();
  await shot('action');
  await ask.click();
  await editor.waitFor({ state: 'visible' });
  assert.equal(await editor.inputValue(), `\`${path}\``);
  assert.equal(calls.filter(c => c.data.name === 'neo.message.send').length, 0, 'Ask only prepares a draft');
  const text = `\`${path}\`\n\nExplain this current file ${width}.`;
  await editor.fill(text);
  await page.reload();
  await editor.waitFor();
  await page.waitForFunction(expected => document.getElementById('neo-thought')?.value === expected, text);
  assert.equal(await editor.inputValue(), text);
  await shot('restored');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('neo-thought')?.value === '');
  const sent = calls.filter(c => c.data.name === 'neo.message.send').at(-1);
  assert(sent, 'ordinary question reaches the real RPC door');
  assert.equal(sent.data.input.content, text);
  assert.equal(sent.data.input.previewContext, undefined);
  const until = Date.now() + 15000;
  while (!replies.has(sent.id ?? sent.requestId)) {
    assert(Date.now() < until, 'real intake receipt timeout');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const receipt = replies.get(sent.id ?? sent.requestId);
  const value = receipt.data?.value ?? receipt.data;
  assert.equal(value.ok, true, JSON.stringify(receipt));
  await showQuestion();
  await writeFile(path, '# Ask current file B\n');
  await card.click();
  await page.getByRole('heading', { name: 'Ask current file B', exact: true }).waitFor();
  await ask.waitFor();
  await showQuestion();
  await unlink(path);
  await card.click();
  await page.getByText("This file hasn't been created yet, or no longer exists.", { exact: true }).waitFor();
  assert.equal(await ask.count(), 0);
  await shot('missing');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.deepEqual(await inventory(), before, 'new live questions must not create or alter saved files');
  assert(!calls.some(c => /^artifact\.(file\.register|reference\.resolve)$/.test(c.data.name)));
  const result = { width, ownerPath: path, draftText: text, sentInput: sent.data.input, receipt: value, ordinaryDraft: true, restored: true, currentReadEditDelete: true, missingActionAbsent: true, noRegistration: true, noRowsOrBlobs: true, pageErrors: errors };
  await writeFile(join(run, 'evidence', `file-question-${width}.json`), JSON.stringify(result, null, 2));
  return result;
}
