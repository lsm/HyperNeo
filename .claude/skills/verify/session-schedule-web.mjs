import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const [port, run, mode] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const surfaces = JSON.parse(readFileSync(`${run}/evidence/schedule-web-seed.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const observed = [];
async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
}
function rpc(name, input) {
  const response = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT:port }, encoding:'utf8' }));
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply;
}
function list(sessionId) {
  const result = rpc('schedule.session.list', { target: { adapter:'hyperneo', id: sessionId } });
  assert(result.ok);
  return result.schedules;
}
try {
  const page = await browser.newPage({ viewport: { width:1280, height:1000 }, locale:'en-US' });
  for (const width of [1280, 390]) for (const surface of surfaces) {
    await page.setViewportSize({ width, height:1000 });
    const path = surface.name === 'neo' ? '/neo' : `/session/${surface.sessionId}`;
    await page.goto(`http://127.0.0.1:${port}${path}`);
    const strip = page.locator(`[data-session-schedules="${surface.sessionId}"]`);
    await strip.waitFor({ timeout:30000 });
    assert.equal(await strip.getAttribute('open'), null);
    await strip.getByText('Schedules', { exact:true }).click();
    const row = strip.locator(`[data-schedule="${surface.scheduleId}"]`);
    await row.waitFor();
    assert.equal(await strip.locator('[data-schedule]').count(),2);
    for (const other of surfaces.filter(item => item.name !== surface.name)) {
      assert.equal(await strip.locator(`[data-schedule="${other.scheduleId}"]`).count(),0);
    }
    assert((await row.innerText()).includes('Every 60 min'));

    assert((await row.innerText()).includes('Skipped · Session busy'));
    assert.equal(await row.locator('time').count(),2);
    assert((await strip.innerText()).includes('0 9 * * * · UTC'));
    await row.getByRole('button',{ name:surface.title, exact:true }).click();
    await row.getByText('Guide publicly available').waitFor();
    await row.getByRole('button',{ name:'Pause', exact:true }).click();
    await row.getByRole('button',{ name:'Resume', exact:true }).waitFor();
    assert.equal(list(surface.sessionId).find(item => item.id === surface.scheduleId).status,'paused');
    await row.getByRole('button',{ name:'Resume', exact:true }).click();
    await row.getByRole('button',{ name:'Pause', exact:true }).waitFor();
    assert.equal(list(surface.sessionId).find(item => item.id === surface.scheduleId).status,'active');
    await strip.getByRole('button',{ name:'Refresh schedules', exact:true }).click();
    await strip.getByRole('button',{ name:'Refresh schedules', exact:true }).waitFor({ state:'visible' });
    await row.getByRole('button',{ name:'Pause', exact:true }).waitFor();
    await page.waitForFunction(id => !document.querySelector(`[data-session-schedules="${id}"] > div > button`)?.disabled, surface.sessionId);
    if (mode !== 'reproduce' && width === 1280 && surface.name === 'neo') {
      const goalId = list(surface.sessionId).find(item => item.id === surface.scheduleId).sourceId;
      assert(rpc('goal.session.update', { ownerSessionId:surface.sessionId, goalId, title:'Guide renamed externally' }).accepted);
      await row.getByRole('button',{ name:'Guide renamed externally', exact:true }).waitFor({ timeout:45000 });
      assert(rpc('goal.session.update', { ownerSessionId:surface.sessionId, goalId, title:surface.title }).accepted);
      await strip.getByRole('button',{ name:'Refresh schedules', exact:true }).click();
      await row.getByRole('button',{ name:surface.title, exact:true }).waitFor();
    }
    const box = await strip.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1,JSON.stringify(box));
    await settle(page);
    await page.screenshot({ path:`${run}/evidence/schedules-${surface.name}-${width}.png`, fullPage:true });
    observed.push({ surface:surface.name, width, target:surface.sessionId, text:await strip.innerText(), controlsPersisted:true, visibleRefresh:mode !== 'reproduce' && width === 1280 && surface.name === 'neo' });
  }
  const scope = JSON.parse(readFileSync(`${run}/evidence/schedule-web-space.json`, 'utf8'));
  const requests = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.data?.name === 'schedule.session.list') requests.push(message.data);
  }));
  await page.goto(`http://127.0.0.1:${port}/space/${scope.spaceId}/session/${scope.worker}`);
  await page.locator('[data-messages-container]').waitFor({ timeout:30000 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const spaceStrips = await page.locator('[data-session-schedules]').count();
  await settle(page);
  await page.screenshot({ path:`${run}/evidence/schedules-space.png`, fullPage:true });
  observed.push({ surface:'space', spaceStrips, requests });
  writeFileSync(`${run}/evidence/schedule-web.json`, JSON.stringify(observed,null,2));
  assert.equal(spaceStrips,0,'Space chats must not mount the schedule strip');
  assert.equal(requests.length,0,'Space chats must not read schedules');
  for (const entry of observed.filter(item => item.text)) {
    assert(entry.text.includes(entry.surface === 'neo' ? 'Nudge due' : 'Nudge in 2'),entry.text);
    assert(!entry.text.includes('Nudge in -'),entry.text);
  }
  console.log(`PASS: session and Neo strips at desktop/mobile widths; facts, goal definition, target isolation and RPC-backed controls. ${run}/evidence/schedule-web.json`);
} finally { await browser.close(); }
