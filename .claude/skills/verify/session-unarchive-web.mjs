import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [out, desktopId, phoneId] = process.argv.slice(2);
const port = process.env.VERIFY_PORT;
assert(out && desktopId && phoneId && port && port !== '8399');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(process.env.RUN, 'data'));

const rpc = (name, input) => {
  const reply = JSON.parse(
    execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
      encoding: 'utf8',
    })
  ).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply;
};

const { chromium } = createRequire(import.meta.url)('playwright');
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER,
});
try {
  for (const [label, sessionId, width, height, hasTouch] of [
    ['desktop', desktopId, 1280, 900, false],
    ['phone', phoneId, 390, 844, true],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch, locale: 'en-US' });
    const name = `Isolated ${label} browser`;
    const { code } = rpc('device.pair.create', { kind: 'human', name });
    assert(code, 'Pairing code missing');
    const paired = await context.request.post(`${origin}/pair`, {
      headers: { origin },
      data: { code, name },
    });
    assert.equal(paired.status(), 200, 'Browser pairing failed');
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/sessions`);
      const row = page.getByTestId("session-row").filter({ has: page.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`) });
      if (hasTouch) {
        await page.getByRole('button', { name: 'Open navigation menu' }).tap();
        assert(await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
      }
      await row.waitFor({ timeout: 10000 });
      if (!hasTouch) await row.hover();
      const button = row.getByRole('button', { name: 'Unarchive', exact: true });
      await button.scrollIntoViewIfNeeded({ timeout: 5000 });
      await page.screenshot({ path: join(out, `${label}.png`), animations: 'disabled' });
      if (hasTouch) await button.tap({ timeout: 5000 });
      else await button.click();
      await page.getByText('Chat unarchived with a fresh worktree from dev').waitFor({ timeout: 5000 });
      await button.waitFor({ state: 'detached', timeout: 5000 });
      const { session } = rpc('rpc:session.get', { sessionId });
      assert.equal(session.status, 'active');
      assert.equal(session.archivedAt, undefined);
      const message = rpc('rpc:message.send', { sessionId, content: 'Reply after unarchive' });
      assert(message.messageId);
      console.log(`PASS: ${label} action restored one session and it accepted a message`);
    } catch (error) {
      await page.screenshot({ path: join(out, `${label}-failure.png`) });
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
