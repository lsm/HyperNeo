import assert from 'node:assert/strict';

export async function verifySearchRefresh(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  const reads = [], held = [], snapshotIds = new Set();
  let hold = false, refreshed;
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try { const value = JSON.parse(String(payload)); if (value.data?.name === 'neo.snapshot') snapshotIds.add(value.id); } catch {}
    });
    socket.on('framereceived', ({ payload }) => {
      try { const value = JSON.parse(String(payload)); if (snapshotIds.has(value.requestId)) refreshed?.(); } catch {}
    });
  });
  await page.routeWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, ws => {
    const server = ws.connectToServer();
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.data?.name === 'neo.ask.read') {
        reads.push(request.data.input.askId);
        if (hold) { held.push(() => server.send(raw)); return; }
      }
      server.send(raw);
    });
  });
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  const work = page.locator('.neo-scene-list:visible');
  await use(work.getByRole('button', { name: 'Search work', exact: true }));
  const input = work.getByRole('searchbox', { name: 'Search work', exact: true });
  await input.fill('needle');
  const results = work.locator('[data-scene-group="search"] [data-ask]');
  await results.nth(3).waitFor();
  const firstReads = reads.length;
  assert.equal(firstReads, fixture.cases.length);
  const refresh = async changed => {
    const arrived = new Promise(resolve => { refreshed = resolve; });
    await page.request.get(new URL(`/__verify-refresh${changed ? '?changed=1' : ''}`, fixture.url).href);
    await arrived;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  hold = true;
  await refresh(false);
  const extraReads = reads.length - firstReads;
  assert.equal(extraReads, phase === 'before' ? fixture.cases.length : 0);
  assert.equal(await results.count(), phase === 'before' ? 0 : 4);
  assert.equal(await work.getByText('Searching work…', { exact: true }).count(), phase === 'before' ? 1 : 0);
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-unchanged-refresh-${phase}.png`, scale: 'css' });
  hold = false; for (const release of held.splice(0)) release();
  await results.nth(3).waitFor();
  if (phase === 'after') {
    hold = true;
    await refresh(true);
    assert.equal(reads.length - firstReads, 1);
    assert.equal(reads.at(-1), 'report-match');
    assert.equal(await results.count(), 4);
    await work.getByText('Searching work…', { exact: true }).waitFor();
    await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-changed-refresh-pending.png`, scale: 'css' });
    hold = false; for (const release of held.splice(0)) release();
    await work.getByText('Searching work…', { exact: true }).waitFor({ state: 'detached' });
    await input.fill('refreshedsigil737');
    await results.first().waitFor();
    assert.equal(await results.first().getAttribute('data-ask'), 'report-match');
  }
  return { touch, firstReads, extraReads, onlyChangedCardReread: phase === 'after', resultsRetained: phase === 'after' };
}
