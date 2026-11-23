import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, code, output, run] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const selectionKey = 'hyperneo_new_chat_selection';
const setCodexDefault = (harness) => {
  const { reply } = JSON.parse(execFileSync('bun', [
    '.claude/skills/verify/rpc.ts', 'rpc:operation.invoke',
    JSON.stringify({
      name: 'oxap.settings.save',
      input: {
        providerId: 'anthropic-codex', harness,
        ...(harness === 'oxap-codex' ? { settings: { executable: '/usr/bin/true' } } : {}),
      },
    }),
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'), VERIFY_PORT: port },
  }));
  assert.deepEqual(reply, { accepted: true });
};

try {
  const initial = await browser.newPage();
  const paired = await initial.request.post(`${base}/pair`, {
    headers: { origin: base }, data: { code, name: 'Synthetic harness browser' },
  });
  assert.equal(paired.status(), 200);
  const storageState = await initial.context().storageState();
  await initial.close();

  for (const width of [390, 1280, 320]) {
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
        localStorage.setItem(selectionKey, JSON.stringify(id ? { model: { id, provider } } : {}));
      }, { selectionKey, id, provider });
      await page.reload();
    };
    const model = page.getByRole('button', { name: 'Choose model, client and thinking' });
    const choices = page.getByRole('group', { name: 'Client', exact: true });
    const choose = async (name) => {
      await click(model);
      await click(choices.getByRole('button', { name, exact: true }));
      await choices.waitFor({ state: 'hidden' });
    };
    const screenshot = async (name) => {
      const sandbox = page.getByRole('button', { name: 'Sandbox', exact: true });
      const start = page.getByRole('button', { name: 'Start chat' });
      const controls = [model, ...(await sandbox.count() ? [sandbox] : []), start];
      const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
      const middle = (box) => box.y + box.height / 2;
      assert(boxes.every(Boolean), `${name} controls are visible at ${width}px`);
      assert(boxes.every((box) => Math.abs(middle(box) - middle(boxes[0])) <= 1),
        `${name} toolbar wraps at ${width}px`);
      assert(boxes.every((box, index) => box.x >= 0 && box.x + box.width <= width + 1 &&
        (index === 0 || boxes[index - 1].x + boxes[index - 1].width <= box.x + 1)),
        `${name} controls overlap or overflow at ${width}px`);
      for (const control of controls.slice(1, -1)) {
        const box = await control.boundingBox();
        assert.equal(box.width, box.height, 'The control should be round');
        assert.equal(await control.innerText(), '', 'The control should display only an icon');
      }
      if (width !== 320) {
        await page.screenshot({
          path: join(output, `client-picker-${name}-${width}.png`), animations: 'disabled',
        });
      }
    };
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
      return { request, session: response.data.session };
    };

    setCodexDefault('sdk');
    await open('codex-6-luna', 'anthropic-codex');
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
    await model.waitFor();
    assert.match(await model.innerText(), /Claude Code/);
    assert.equal(await model.getAttribute('aria-description'), 'Client: Claude Code');
    assert.equal(await model.locator(':scope > svg').count(), 0, 'The picker has no trailing chevron');
    await screenshot('default');
    await click(model);
    assert.equal(await choices.getByRole('button', { name: 'Claude Code', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await submit(undefined, undefined);

    await open('codex-6-luna', 'anthropic-codex');
    await choose('OXAP Codex');
    assert.match(await model.innerText(), /OXAP Codex/);
    await screenshot('override');
    await submit('oxap-codex', 'oxap-codex');

    await open('codex-6-luna', 'anthropic-codex');
    assert.match(await model.innerText(), /Claude Code/);
    setCodexDefault('oxap-codex');
    await open('codex-6-luna', 'anthropic-codex');
    const configured = choices.getByRole('button', { name: 'OXAP Codex', exact: true, pressed: true });
    await click(model);
    await configured.waitFor();
    await click(choices.getByRole('button', { name: 'Claude Code', exact: true }));
    assert.match(await model.innerText(), /Claude Code/);
    await submit('sdk', undefined);
    await open('deepseek-v4-pro', 'deepseek');
    await click(model);
    const unavailable = choices.getByRole('button', { name: /OXAP DeepSeek.*Set up in Settings/ });
    assert.equal(await unavailable.isDisabled(), true);
    const menu = page.getByRole('group', { name: 'Model, client and thinking settings' });
    const bounds = await menu.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert(bounds.y >= 8, `The picker is clipped at the top at ${width}px`);
    await screenshot('disabled');
    await page.keyboard.press('Escape');
    await submit(undefined, undefined);
    setCodexDefault('sdk');
    await open();
    await choose('OXAP Codex');
    assert.match(await model.innerText(), /OXAP Codex/);
    const { request, session } = await submit('oxap-codex', 'oxap-codex');
    assert.deepEqual(request.config, { provider: 'anthropic-codex' }, 'An override should omit an unknown model');
    assert.equal(session.config.model, 'codex-6-luna', 'The daemon should resolve the configured fallback');
    console.log(JSON.stringify({ width, touch, creations: creations.length, defaultOmitted: true, oxapOverride: true, sdkOverride: true, unavailableDisabled: true, modelResolvedByDaemon: true }));
    await context.close();
  }
} finally {
  await browser.close();
}
