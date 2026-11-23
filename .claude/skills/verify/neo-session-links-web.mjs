import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { revealAsk } from './queue-ask.mjs';
import { leaveSession, sessionTitle } from './session-pane-web.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.VERIFY_BROWSER });
const observations = [];

try {
  for (const desktop of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    try {
      await page.addInitScript((desktop) => {
        window.openedSessions = [];
        window.open = (url, target, features) => {
          window.openedSessions.push({ url, target, features });
          return null;
        };
        if (desktop) {
          window.__TAURI_INTERNALS__ = {
            invoke: async (command, { url }) => {
              window.openedSessions.push({ command, url });
              if (url.startsWith('ghapp:')) throw new Error('Synthetic missing application');
            },
          };
        }
      }, desktop);
      await page.goto(fixture.url);
      const expected = [];
      for (const { id, link } of fixture.sessions.filter(({ link }) => !link.startsWith('/'))) {
        const card = await revealAsk(page, `open-${id}`);
        for (const control of [
          card.locator('[data-question-source] button'),
          card.locator('[data-ask-todo] button[aria-label^="Open "]'),
        ]) {
          await control.click();
          expected.push(
            desktop
              ? { command: 'plugin:session-links|open', url: link }
              : { url: link, target: '_blank', features: 'noopener' }
          );
        }
      }
      if (desktop) await page.getByText(/Could not open the session link/).first().waitFor();
      const local = await revealAsk(page, 'open-local-worker');
      await local.locator('[data-question-source] button').click();
      await sessionTitle(page, { name: /Local worker/ }).waitFor();
      await leaveSession(page);
      await local.getByRole('button', { name: 'Continue', exact: true }).waitFor();
      assert.equal(page.url(), fixture.url);
      const attempts = await page.evaluate(() => window.openedSessions);
      assert.deepEqual(attempts, expected);
      observations.push({ desktopBridgeFixture: desktop, attempts, localNavigation: true });
    } finally {
      await page.close();
    }
  }
  const report = { phase: fixture.phase, passed: true, observations };
  writeFileSync(join(fixture.run, 'evidence/browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.kill(fixture.pid, 'SIGUSR1');
} finally {
  await browser.close();
}
