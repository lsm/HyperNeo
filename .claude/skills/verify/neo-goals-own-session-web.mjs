import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const [port, run, label = 'after'] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
mkdirSync(`${run}/evidence`, { recursive: true });
function rpc(name, input) {
  const response = JSON.parse(
    execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
      env: { ...process.env, VERIFY_PORT: port },
      encoding: 'utf8',
    })
  );
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply;
}
const root = rpc('neo.open', {}).sessionId;
const cadence = { kind: 'every', everyMs: 3600000 };
const plain = rpc('goal.session.create', {
  ownerSessionId: root,
  title: 'Plain Neo goal',
  doneTest: 'Done',
  cadence,
});
const own = rpc('goal.session.create', {
  ownerSessionId: root,
  title: 'Parental control: close must-have gaps',
  doneTest: 'Every must-have gap is closed',
  cadence,
  ownSession: true,
});
assert(plain.accepted && own.accepted, JSON.stringify({ plain, own }));
assert.notEqual(own.goal.ownerSessionId, root, 'ownSession must start a child owner session');
const next = rpc('schedule.session.list', {
  target: { adapter: 'hyperneo', id: own.goal.ownerSessionId },
}).schedules.find((row) => row.sourceKind === 'goal' && row.sourceId === own.goal.id).nextRunAt;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
let page;
const observed = { label, root, ownOwner: own.goal.ownerSessionId, expectedNextWake: next };
try {
  const base = `http://127.0.0.1:${port}`;
  const pair = rpc('device.pair.create', { kind: 'human', name: 'Synthetic goals browser' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: 'en-US',
  });
  const paired = await context.request.post(`${base}/pair`, {
    headers: { origin: base },
    data: { code: pair.code, name: 'Synthetic goals browser' },
  });
  assert.equal(paired.status(), 200);
  page = await context.newPage();
  await page.goto(`${base}/neo`);
  await page
    .getByRole('navigation', { name: 'Work views' })
    .getByRole('button', { name: 'Goals', exact: true })
    .click();
  const section = page.getByRole('region', { name: 'Goals', exact: true });
  await section.getByText('Plain Neo goal', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${run}/evidence/neo-goals-own-session-${label}.png` });
  observed.text = await section.innerText();
  const card = section.locator('[data-neo-goal]', {
    hasText: 'Parental control: close must-have gaps',
  });
  observed.ownGoalShown = (await card.count()) === 1;
  observed.ownGoalNextWake = observed.ownGoalShown
    ? await card.locator('time').getAttribute('datetime')
    : null;
  assert(observed.ownGoalShown, 'The own-session goal must be listed on the Goals tab');
  assert.equal(observed.ownGoalNextWake, new Date(next).toISOString());
  observed.passed = true;
  console.log(`PASS: own-session goal listed with its real next wake. ${run}/evidence`);
} catch (error) {
  observed.error = String(error);
  await page?.screenshot({ path: `${run}/evidence/neo-goals-own-session-${label}-failure.png` });
  throw error;
} finally {
  writeFileSync(
    `${run}/evidence/neo-goals-own-session-${label}.json`,
    JSON.stringify(observed, null, 2)
  );
  await browser.close();
}
