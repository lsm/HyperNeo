import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
function rpc(name, input = {}) {
  const result = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!result.error, JSON.stringify(result));
  return result;
}
async function control(command) {
  rmSync(`${run}/control.ack`, { force: true });
  writeFileSync(`${run}/control`, `${command}\n`);
  if (command === 'done') return;
  for (let i = 0; i < 120 && !existsSync(`${run}/control.ack`); i++) await new Promise((r) => setTimeout(r, 250));
  assert(existsSync(`${run}/control.ack`), `daemon ${command} timed out`);
}
const muted = () => rpc('neo.snapshot').mutedSessions;
const created = rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Synthetic login fix' });
const named = `hyperneo::${created.sessionId}`;
const unnamed = 'hyperneo::synthetic-session-gone';
const codex = 'codex-desktop:synthetic-mac:thread-42';
const claude = 'claude-desktop::local_synthetic-7';
const seeded = [named, unnamed, codex, claude];
for (const key of seeded) assert.equal(rpc('neo.session.mute', { key, muted: true }).ok, true);
assert.deepEqual(muted(), seeded);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = { seeded, observations: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await page.goto(`http://127.0.0.1:${port}/settings?tab=neo-model`);
  const section = page.getByRole('region', { name: 'Neo muted sessions', exact: true });
  const rows = section.getByRole('listitem');
  await section.getByText(named, { exact: true }).waitFor();
  assert.equal(await rows.count(), 4);
  const texts = await rows.allInnerTexts();
  assert(texts[0].includes('Synthetic login fix'));
  for (const [index, key] of seeded.entries()) assert(texts[index].includes(key));
  assert(texts.slice(1).every((text) => !text.includes('Synthetic login fix')));
  evidence.listsEveryKey = true;
  evidence.namesOnlyResolvable = true;

  await section.getByRole('button', { name: `Unmute ${codex}`, exact: true }).click();
  await section.getByText(codex, { exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(muted(), [named, unnamed, claude]);
  evidence.unmuteDropsOnlyTarget = true;

  await control('stop');
  await page.waitForTimeout(1500);
  await section.getByRole('button', { name: `Unmute ${unnamed}`, exact: true }).click();
  await section.getByText('Reconnect before unmuting a session.', { exact: true }).waitFor();
  assert.equal(await rows.count(), 3);
  await section.screenshot({ path: `${run}/evidence/neo-muted-sessions-disconnected.png`, animations: 'disabled' });
  await control('start');
  assert.deepEqual(muted(), [named, unnamed, claude]);
  evidence.disconnectKeepsRow = true;

  const current = [named, unnamed, claude];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await section.getByText(named, { exact: true }).waitFor();
    const shown = await rows.allInnerTexts();
    assert.equal(shown.length, current.length);
    for (const [index, key] of current.entries()) assert(shown[index].includes(key));
    const overflow = await section.evaluate((element) => [...element.querySelectorAll('button,li')].filter((child) => { const rect = child.getBoundingClientRect(); return rect.x < 0 || rect.right > innerWidth + 1; }).map((child) => child.outerHTML.slice(0, 120)));
    assert.deepEqual(overflow, []);
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: `${run}/evidence/neo-muted-sessions-${width}.png`, animations: 'disabled' });
    evidence.observations.push({ width, rows: shown.length, matchesSnapshot: true, controlsFit: true });
  }
  console.log('PASS: Settings > Neo muted sessions lists every key, names only a resolvable session, unmutes one key on success, keeps the row while disconnected, and matches the snapshot after reload at 1280/390 px.');
} finally {
  writeFileSync(`${run}/evidence/neo-muted-sessions-settings.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
  await control('done');
}
