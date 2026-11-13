import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyOwnerFileCards(page, { base, report, evidence, width }) {
  const calls = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const call = JSON.parse(String(frame.payload)); if (call.method === 'operation.invoke' && /^(file\.reference|artifact\.)/.test(call.data?.name)) calls.push(call.data); } catch {}
  }));
  const shot = async (name) => {
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    await page.screenshot({ path: join(evidence, `${name}-${width}.png`) });
  };
  await page.goto(`${base}/neo`);
  await page.getByText('CLAUDE.md', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open current file: CLAUDE.md' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Open preview: CLAUDE.md' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Open preview: docs/guide.md' }).count(), 0);
  const card = page.getByRole('button', { name: 'Open current file: review-report.md', exact: true });
  assert.equal(await card.count(), 1);
  await shot('owner-cards');
  const close = async () => {
    const button = page.getByRole('button', { name: 'Close review-report.md', exact: true });
    if (await button.count()) await button.click();
    else await page.getByRole('button', { name: 'Back', exact: true }).click();
  };
  for (const version of ['A', 'B']) {
    await writeFile(report, `# Review ${version}\n`);
    await card.click();
    await page.getByRole('heading', { name: `Review ${version}`, exact: true }).waitFor();
    await shot(`owner-current-${version}`);
    await close();
  }
  await unlink(report);
  await card.click();
  await page.getByText("This file hasn't been created yet, or no longer exists.", { exact: true }).waitFor();
  await shot('owner-missing');
  await close();
  await writeFile(report, '# Review A\n');
  assert(calls.filter(call => call.name === 'file.reference.read').length >= 3);
  assert(calls.every(call => call.name === 'file.reference.read' && call.input.reference === report && call.input.sourceMessageOrCard.kind === 'publication'));
  const observed = { calls, width, bareAndRelativeNotInteractive: true, absoluteCardWorks: true, currentReadEditDelete: true };
  await writeFile(join(evidence, `owner-web-${width}.json`), JSON.stringify(observed, null, 2));
  return observed;
}
