import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyAllReadError(page, fixture, { phase, evidence, touch = false }) {
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, ws => {
    const server = ws.connectToServer();
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.type === 'REQ' && request.data?.name === 'neo.ask.read' && request.data.input.askId === 'all-items') {
        ws.send(JSON.stringify({ ...request, id: randomUUID(), requestId: request.id, type: 'RSP', data: undefined, error: 'Synthetic All read unavailable' }));
      } else server.send(raw);
    });
  });
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  const card = page.locator('[data-ask="all-items"]:visible');
  await card.getByText('Synthetic All read unavailable', { exact: true }).waitFor();
  await use(card.getByRole('button', { name: 'All · 30', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Synthetic All items', exact: true });
  await dialog.getByText('Synthetic All read unavailable', { exact: true }).waitFor();
  const errorCount = await page.getByText('Synthetic All read unavailable', { exact: true }).count();
  assert.equal(errorCount, phase === 'before' ? 2 : 1);
  await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-read-error-${phase}.png`, scale: 'css' });
  await use(dialog.getByRole('button', { name: 'Close modal', exact: true }));
  await dialog.waitFor({ state: 'detached' });
  await card.getByText('Synthetic All read unavailable', { exact: true }).waitFor();
  return { touch, errorCount, cardErrorRestored: true };
}

export async function verifyAllSession(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  const card = page.locator('[data-ask="all-items"]:visible');
  await use(card.getByRole('button', { name: 'All · 30', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Synthetic All items', exact: true });
  await dialog.locator('[data-todo-state="done"]').nth(19).waitFor();
  await use(dialog.getByRole('button', { name: '5 done — show more', exact: true }));
  await use(dialog.getByRole('button', { name: 'Open Completed All step 25', exact: true }));
  await page.locator('.neo-session-pane').getByRole('heading', { name: /Synthetic All worker/ }).waitFor();
  assert.equal(await dialog.count(), phase === 'before' ? 1 : 0);
  await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-all-session-${phase}.png`, scale: 'css' });
  if (phase === 'before') await use(dialog.getByRole('button', { name: 'Close modal', exact: true }));
  await use(page.locator('.neo-session-pane').getByRole('button', { name: 'Back to Neo', exact: true }));
  return { touch, dialogRemainsOverSession: phase === 'before', sessionNavigation: true };
}
