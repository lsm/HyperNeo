import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

async function settle(page) {
  await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'), null, { timeout: 10000 });
}

export async function verifyFilteredWorkReference(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  await use(page.getByRole('button', { name: 'Search work', exact: true }));
  const input = page.getByRole('searchbox', { name: 'Search work', exact: true });
  await input.fill('navigationmissingword999');
  await page.getByText('No matching work', { exact: true }).waitFor();
  if (touch) await use(page.getByRole('button', { name: 'Close work list', exact: true }));
  await use(page.getByRole('button', { name: /I replied · View card.*Saved answered reference/ }));
  const dialog = page.getByRole('dialog', { name: 'Stored navigation card', exact: true });
  if (phase === 'before') {
    await page.getByText('Opening work…', { exact: true }).waitFor({ state: 'detached' });
    await page.getByText('No matching work', { exact: true }).waitFor();
    assert.equal(await dialog.count(), 0);
  } else {
    await dialog.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'neo-ref-question-nav-answered');
    assert.equal(await input.inputValue(), '');
  }
  await settle(page);
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-filtered-reference-${phase}.png`, scale: 'css' });
  return { touch, filterCleared: phase === 'after', openedAtTarget: phase === 'after' };
}

export async function verifyWorkReferenceRecovery(page, fixture, { evidence, touch = false }) {
  let fail = true, hold = false;
  const held = [];
  const received = new Set();
  let heldId;
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, ws => {
    const server = ws.connectToServer();
    server.onMessage(raw => { received.add(JSON.parse(String(raw)).requestId); ws.send(raw); });
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.type === 'REQ' && request.data?.name === 'neo.ask.read' && request.data.input.questionId) {
        if (fail) { fail = false; ws.send(JSON.stringify({ ...request, id: randomUUID(), requestId: request.id, type: 'RSP', data: undefined, error: 'Synthetic reference refusal' })); return; }
        if (hold) { heldId = request.id; held.push(() => server.send(raw)); return; }
      }
      server.send(raw);
    });
  });
  const use = control => touch ? control.tap() : control.click();
  const link = page.getByRole('button', { name: /I replied · View card.*Saved answered reference/ });
  const dialog = page.getByRole('dialog', { name: 'Stored navigation card', exact: true });
  const back = page.getByRole('button', { name: 'Back to chat', exact: true });
  await page.goto(fixture.url);
  await use(link);
  await page.getByText('This card is no longer available.', { exact: true }).waitFor();
  await use(back);
  hold = true;
  await use(link);
  await page.getByText('Opening work…', { exact: true }).waitFor();
  await page.waitForFunction(() => document.body.textContent.includes('Opening work…'));
  assert(held.length > 0);
  await use(back);
  hold = false;
  for (const release of held.splice(0)) release();
  for (let attempt = 0; !received.has(heldId) && attempt < 100; attempt++) await page.waitForTimeout(20);
  assert(received.has(heldId));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.locator('[data-ask="nav-history"]').count(), 0);
  await use(link);
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'neo-ref-question-nav-answered');
  await page.keyboard.press('Escape');
  await use(back);
  await use(link);
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'neo-ref-question-nav-answered');
  await settle(page);
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-reference-retry.png`, scale: 'css' });
  return { touch, refusalVisible: true, cancelledReadStayedClosed: true, retryOpenedTarget: true, repeatedActivation: true };
}

export async function verifyWorkItemNavigation(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  const reads = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { const value = JSON.parse(String(payload)); if (value.data?.name?.startsWith('neo.ask.')) reads.push(value.data); } catch {}
  }));
  const observed = [];
  for (const item of [
    { kind: 'todo', id: 'nav-done-25', title: 'Completed navigation card' },
    { kind: 'question', id: 'nav-answered', title: 'Stored navigation card', label: 'Saved answered reference' },
    { kind: 'question', id: 'nav-retired', title: 'Stored navigation card', label: 'Saved retired reference' },
  ]) {
    await page.goto(fixture.url);
    const control = item.kind === 'todo'
      ? page.locator('[data-reply-to="todo:nav-done-25"] button')
      : page.getByRole('button', { name: new RegExp(`I replied · View card.*${item.label}`) });
    await control.waitFor();
    await use(control);
    if (phase === 'before') {
      if (item.kind === 'question') await page.getByText('This card is no longer available.', { exact: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole('dialog', { name: item.title, exact: true }).count(), 0);
    } else {
      const dialog = page.getByRole('dialog', { name: item.title, exact: true });
      await dialog.waitFor();
      await page.waitForFunction(id => document.activeElement?.id === id, `neo-ref-${item.kind}-${item.id}`);
      assert(await dialog.evaluate(element => element.contains(document.activeElement)));
      const box = await dialog.boundingBox(), viewport = page.viewportSize();
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
      if (item.kind === 'todo') assert.equal(await dialog.locator('[data-todo-state="done"]').count(), 25);
    }
    await settle(page);
    await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-${item.id}-${phase}.png`, scale: 'css' });
    observed.push({ ...item, openedAtTarget: phase === 'after' });
  }
  if (phase === 'after') assert(reads.some(read => read.name === 'neo.ask.doneTodos' && read.input.offset === 20));
  return { touch, observed, reads };
}
