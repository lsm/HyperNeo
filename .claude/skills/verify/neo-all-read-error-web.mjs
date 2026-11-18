import assert from 'node:assert/strict';
import { leaveSession, sessionTitle } from './session-pane-web.mjs';
import { randomUUID } from 'node:crypto';
import { queueSection, revealAsk } from './queue-ask.mjs';

export async function verifyAllReadError(page, fixture, { phase, evidence, touch = false }) {
  const refused = new Set(['all-items', 'all-history']);
  let reads = 0;
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, ws => {
    const server = ws.connectToServer();
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.type === 'REQ' && request.data?.name === 'neo.ask.read' && refused.has(request.data.input.askId)) {
        reads++;
        ws.send(JSON.stringify({ ...request, id: randomUUID(), requestId: request.id, type: 'RSP', data: undefined, error: 'Synthetic All read unavailable' }));
      } else server.send(raw);
    });
  });
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  await page.locator('[data-human-queue]:visible').waitFor();
  const section = await queueSection(page, 'all-items');
  assert(section, 'the unfinished ask is in the queue');
  await section.getByRole('alert').first().waitFor();
  assert.equal(await section.locator('[data-queue-open]').count(), 0, 'no full ask from a refused read');
  const before = reads;
  await use(section.getByRole('button', { name: 'Retry', exact: true }).first());
  for (let attempt = 0; reads === before && attempt < 200; attempt++) await page.waitForTimeout(25);
  assert(reads > before, 'Retry reads the ask again');
  await section.getByRole('alert').first().waitFor();
  refused.delete('all-items');
  await use(section.getByRole('button', { name: 'Retry', exact: true }).first());
  await section.locator('[data-queue-open]').waitFor();
  assert.equal(await section.getByRole('alert').count(), 0, 'a good read clears the queue error');
  const card = page.locator('[data-ask="all-history"]:visible');
  await card.waitFor();
  await card.evaluate(node => node.scrollIntoView({ block: 'center' }));
  assert.equal(await card.getByText('Synthetic All read unavailable', { exact: true }).count(), 0, 'no read before the human asks for more');
  await use(card.getByRole('button', { name: /^All · \d+$/ }));
  const dialog = page.getByRole('dialog', { name: 'Synthetic finished history', exact: true });
  await dialog.getByText('Synthetic All read unavailable', { exact: true }).waitFor();
  const errorCount = await page.getByText('Synthetic All read unavailable', { exact: true }).count();
  assert.equal(errorCount, phase === 'before' ? 2 : 1);
  await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-read-error-${phase}.png`, scale: 'css' });
  await use(dialog.getByRole('button', { name: 'Close modal', exact: true }));
  await dialog.waitFor({ state: 'detached' });
  await card.getByText('Synthetic All read unavailable', { exact: true }).waitFor();
  return { touch, errorCount, cardErrorRestored: true, queueRetry: true, openAfterGoodRead: true };
}

export async function verifyAllSession(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  const card = await revealAsk(page, 'all-items');
  await use(card.getByRole('button', { name: 'All · 30', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Synthetic All items', exact: true });
  const more = dialog.getByRole('button', { name: '5 done — show more', exact: true });
  await dialog.locator('[data-todo-state="done"]').nth(19).waitFor();
  if (await more.count()) await use(more);
  await use(dialog.getByRole('button', { name: 'Open Completed All step 25', exact: true }));
  await sessionTitle(page, { name: /Synthetic All worker/ }).waitFor();
  assert.equal(await dialog.count(), phase === 'before' ? 1 : 0);
  await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-all-session-${phase}.png`, scale: 'css' });
  if (phase === 'before') await use(dialog.getByRole('button', { name: 'Close modal', exact: true }));
  await leaveSession(page);
  return { touch, dialogRemainsOverSession: phase === 'before', sessionNavigation: true };
}
