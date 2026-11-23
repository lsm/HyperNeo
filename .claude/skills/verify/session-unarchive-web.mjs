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
    page.setDefaultTimeout(10000);
    try {
      await page.goto(`${origin}/sessions`);
      const row = page.getByTestId("session-row").filter({ has: page.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`) });
      if (hasTouch) {
        await page.getByRole('button', { name: 'Open navigation menu' }).tap();
        assert(await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
      }
      const menuTrigger = page.getByRole('button', { name: 'Project actions for Example' });
      const activate = (control) =>
        hasTouch ? control.tap({ timeout: 5000 }) : control.click({ timeout: 5000 });
      await menuTrigger.waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: 'Project actions for Other' }).waitFor();
      assert.equal(await row.count(), 0, 'The archived chat starts hidden');
      await activate(menuTrigger);
      await activate(page.getByRole('menuitemcheckbox', { name: 'Show archived chats', checked: false }));
      await row.waitFor({ timeout: 10000 });
      assert.equal(await page.getByText('Other archived chat', { exact: true }).count(), 0);
      await activate(menuTrigger);
      await page.getByRole('menuitemcheckbox', { name: 'Show archived chats', checked: true }).waitFor();
      const deleteItem = page.getByRole('menuitem', { name: 'Delete this project' });
      await deleteItem.waitFor();
      if (!hasTouch) await row.hover({ position: { x: 12, y: 12 } });
      const button = row.getByRole('button', { name: 'Unarchive', exact: true });
      await button.waitFor({ timeout: 5000 });
      await page.screenshot({ path: join(out, `${label}-project-menu.png`), animations: 'disabled' });
      await activate(deleteItem);
      await page.getByText(/This archives .* in this project/).waitFor();
      await activate(page.getByRole('button', { name: 'Cancel', exact: true }));
      await activate(menuTrigger);
      await activate(page.getByRole('menuitemcheckbox', { name: 'Show archived chats', checked: true }));
      await row.waitFor({ state: 'detached' });
      await activate(menuTrigger);
      await activate(page.getByRole('menuitemcheckbox', { name: 'Show archived chats', checked: false }));
      if (!hasTouch) await row.hover();
      await activate(button);
      await page.getByText('Chat unarchived with a fresh worktree from dev').waitFor({ timeout: 5000 });
      await button.waitFor({ state: 'detached', timeout: 5000 });
      const { session } = rpc('rpc:session.get', { sessionId });
      assert.equal(session.status, 'active');
      assert.equal(session.archivedAt, undefined);
      const message = rpc('rpc:message.send', { sessionId, content: 'Reply after unarchive' });
      assert(message.messageId);
      console.log(`PASS: ${label} menu scoped archived chats, preserved delete confirmation and restored a chat that accepted a message`);
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
