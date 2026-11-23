import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, code, output] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const selectionKey = 'hyperneo_new_chat_selection';

try {
  const initial = await browser.newPage();
  const paired = await initial.request.post(`${base}/pair`, {
    headers: { origin: base }, data: { code, name: 'Synthetic harness browser' },
  });
  assert.equal(paired.status(), 200);
  const storageState = await initial.context().storageState();
  await initial.close();

  for (const width of [1280, 390]) {
    const touch = width < 640;
    const context = await browser.newContext({
      storageState, hasTouch: touch, locale: 'en-US', colorScheme: 'light',
      viewport: { width, height: touch ? 844 : 900 },
      reducedMotion: 'reduce',
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    const creations = [];
    await page.routeWebSocket('**/ws', (client) => {
      const server = client.connectToServer();
      client.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === 'session.create') creations.push({ id: frame.id, request: frame.data });
        if (frame.method !== 'message.send') server.send(raw);
      });
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        const entry = creations.find(({ id }) => id === frame.requestId);
        if (entry) entry.response = frame;
        client.send(raw);
      });
    });
    const click = (locator) => touch ? locator.tap() : locator.click();
    const open = async (id, provider) => {
      await page.goto(`${base}/sessions`);
      await page.evaluate(({ selectionKey, id, provider }) => {
        localStorage.setItem(selectionKey, JSON.stringify({ model: { id, provider } }));
      }, { selectionKey, id, provider });
      await page.reload();
    };
    const screenshot = (name) =>
      page.screenshot({ path: join(output, `${name}-${width}.png`), animations: 'disabled' });
    const submit = async (expectedChoice, expectedStored) => {
      const count = creations.length;
      await page.getByPlaceholder('Ask anything to start a new chat...').fill('Synthetic harness choice');
      await click(page.getByRole('button', { name: 'Start chat' }));
      const deadline = Date.now() + 10_000;
      while (!creations[count]?.response) {
        assert(Date.now() < deadline, 'No session.create response');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const { request, response } = creations[count];
      assert.equal(Object.hasOwn(request, 'harness'), expectedChoice !== undefined);
      assert.equal(request.harness, expectedChoice);
      assert(response.data?.sessionId, JSON.stringify(response.error));
      assert.equal(response.data.session.config.harness, expectedStored);
    };

    await open('codex-6-luna', 'anthropic-codex');
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
    const codex = page.getByRole('button', { name: 'Harness: OXAP Codex' });
    await codex.waitFor({ timeout: 6000 });
    await screenshot('default');
    await submit(undefined, 'oxap-codex');
    await open('codex-6-luna', 'anthropic-codex');
    await click(codex);
    await click(page.getByRole('menuitem', { name: 'Claude Code', exact: true }));
    await page.getByRole('button', { name: 'Harness: Claude Code' }).waitFor();
    await screenshot('override');
    await submit('sdk', undefined);
    await open('deepseek-v4-pro', 'deepseek');
    await click(page.getByRole('button', { name: 'Harness: Claude Code' }));
    const unavailable = page.getByRole('menuitem', { name: /OXAP DeepSeek.*Set up in Settings/ });
    assert.equal(await unavailable.isDisabled(), true);
    const menu = page.getByRole('menu').filter({ has: unavailable });
    const bounds = await menu.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await screenshot('disabled');
    await page.keyboard.press('Escape');
    await submit(undefined, undefined);
    console.log(JSON.stringify({ width, touch, creations: creations.length, defaultOmitted: true, sdkOverride: true, unavailableDisabled: true }));
    await context.close();
  }
} finally {
  await browser.close();
}
