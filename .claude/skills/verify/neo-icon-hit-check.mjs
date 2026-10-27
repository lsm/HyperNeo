import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyIconHitAreas(page, fixture, { phase, evidence, touch = false }) {
  let refusedSends = 0;
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, ws => {
    const server = ws.connectToServer();
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.type === 'REQ' && request.method === 'operation.invoke' && request.data?.name === 'neo.message.send') {
        refusedSends++;
        ws.send(JSON.stringify({ ...request, id: randomUUID(), requestId: request.id, type: 'RSP', data: undefined, error: 'Synthetic message transport unavailable' }));
      } else server.send(raw);
    });
  });
  await page.goto(fixture.url);
  const entry = page.locator('[data-public-entry]').filter({ hasText: 'Copy fixture' });
  await entry.getByRole('heading', { name: 'Copy fixture', exact: true }).waitFor();
  const use = control => touch ? control.tap() : control.click();
  const observations = [];
  const measure = async (name, control) => {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert(box);
    if (phase === 'after' && touch) assert(box.width >= 44 && box.height >= 44, JSON.stringify({ name, box }));
    else assert(box.width < 44 && box.height < 44, JSON.stringify({ name, box }));
    observations.push({ name, width: box.width, height: box.height });
  };
  const footer = await entry.getByRole('button', { name: 'Copy Neo’s message', exact: true }).elementHandle();
  await measure('message copy', footer);
  await measure('reply', entry.getByRole('button', { name: 'Reply to Neo’s message', exact: true }));
  await use(entry.getByRole('button', { name: 'more', exact: true }));
  await entry.locator('pre code').waitFor();
  await measure('details copy', entry.getByRole('button', { name: 'Copy details', exact: true }));
  const code = await entry.getByRole('button', { name: 'Copy code', exact: true }).elementHandle();
  await measure('code copy', code);
  await use(code);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await entry.locator('pre code').textContent());
  await entry.scrollIntoViewIfNeeded();
  await entry.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished));
  });
  await page.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-expanded.png`, scale: 'css' });
  if (phase === 'after' && touch) {
    await footer.scrollIntoViewIfNeeded();
    const box = await footer.boundingBox();
    const normal = await footer.evaluate(button => getComputedStyle(button).backgroundColor);
    try {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(120);
      const pressed = await footer.evaluate(async button => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return { background: getComputedStyle(button).backgroundColor, transform: getComputedStyle(button).transform }; });
      assert.notEqual(pressed.background, normal);
      assert.equal(pressed.transform, 'matrix(0.94, 0, 0, 0.94, 0, 0)');
      await page.screenshot({ path: `${evidence}/mobile-pressed.png`, scale: 'css' });
      observations.push({ pressed, heldPointerInTouchLayout: true });
    } finally { await page.mouse.up(); }
  }
  await page.getByRole('textbox', { name: 'Message Neo', exact: true }).fill('Synthetic retry hit area');
  await use(page.getByRole('button', { name: 'Send message', exact: true }));
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor();
  await measure('retry', retry);
  const prior = refusedSends;
  await use(retry);
  await page.waitForFunction(() => document.querySelector('button[aria-label="Retry"]') !== null);
  assert.equal(refusedSends, prior + 1);
  await retry.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-retry.png`, scale: 'css' });
  return { touch, observations, codeClipboardExact: true, retrySendsOnce: true, controlledTransportFailure: true };
}
