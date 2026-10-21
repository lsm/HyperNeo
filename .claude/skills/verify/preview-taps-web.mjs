import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [phase, directory, port = '9394'] = process.argv.slice(2);
const run = realpathSync(directory);
assert.notEqual(port, '8399');
const verify = fileURLToPath(new URL('.', import.meta.url));
const evidence = join(run, 'evidence', 'preview-taps.json');
const rpc = (name, input) => {
  const out = execFileSync('bun', [join(verify, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port },
    encoding: 'utf8',
  });
  const reply = JSON.parse(out).reply;
  assert(!reply.error, out);
  return reply.value ?? reply;
};

if (phase === 'prepare') {
  rpc('rpc:providers.create', {
    params: {
      providerId: 'anthropic',
      displayName: 'Anthropic (dev proxy)',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
  const opened = rpc('neo.open', {});
  assert(opened.ok, JSON.stringify(opened));
  const registered = rpc('artifact.file.register', {
    requestId: crypto.randomUUID(),
    context: { kind: 'todo', id: 'todo' },
    path: 'notes.md',
    title: 'Synthetic notes',
  });
  assert(registered.accepted, JSON.stringify(registered));
  const ticked = rpc('neo.todo.edit', {
    todoId: 'todo',
    done: 'met',
    evidence: 'Notes registered.',
    artifacts: [registered.artifact],
  });
  assert(ticked.ok, JSON.stringify(ticked));
  writeFileSync(evidence, JSON.stringify({ root: opened.sessionId, ref: registered.artifact }));
  console.log(JSON.stringify({ root: opened.sessionId, ref: registered.artifact }));
  process.exit(0);
}

assert.equal(phase, 'web');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const offOrigin = [];
const observed = {};
const shot = (page, name) => page.screenshot({ path: join(run, 'evidence', `preview-taps-${name}.png`) });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' });
    await context.route('**/*', (route) => {
      if (route.request().url().startsWith(base)) return route.continue();
      offOrigin.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    try {
    await page.goto(`${base}/neo`);
    const article = page.locator('article').filter({ hasText: 'The layout notes are in' });
    await article.waitFor({ timeout: 60_000 });
    const main = page.locator('main.neo-scroll');
    const scrollTop = () => main.evaluate((element) => element.scrollTop);
    const dialog = page.getByRole('dialog');
    const back = () => dialog.getByRole('button', { name: 'Back' }).click();

    const card = article.getByRole('button', { name: 'Open preview: Synthetic notes' });
    assert.equal(await card.innerText(), 'Synthetic notes · Markdown · 63 B · Open preview');
    await card.scrollIntoViewIfNeeded();
    const before = await scrollTop();
    await card.click();
    await dialog.getByRole('heading', { name: 'Synthetic layout notes' }).waitFor();
    await shot(page, `card-${width}`);
    await back();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await scrollTop(), before);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open preview: Synthetic notes');

    await article.getByText('notes.md', { exact: true }).click();
    await dialog.getByRole('heading', { name: 'Synthetic layout notes' }).waitFor();
    observed[`path-${width}`] = await dialog.locator('header p').innerText();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    await article.getByText('https://github.com/lsm/HyperNeo/pull/42').click();
    await page.getByRole('dialog', { name: 'Synthetic design PR' }).waitFor();
    observed[`pr-${width}`] = await dialog.locator('header p').innerText();
    await dialog.getByRole('heading', { name: 'Complete untrusted body' }).waitFor();
    assert.equal(await dialog.locator('script').count(), 0);
    await shot(page, `pr-${width}`);
    await dialog.getByRole('button', { name: /docs\/report\.md/ }).click();
    await dialog.locator('header h1', { hasText: 'report.md' }).waitFor({ timeout: 60_000 });
    observed[`prFile-${width}`] = await dialog.locator('header p').innerText();
    assert.match(observed[`prFile-${width}`], /commit aaaaaaa$/);
    await shot(page, `pr-file-${width}`);
    await back();
    await page.getByRole('dialog', { name: 'Synthetic design PR' }).waitFor();
    await back();
    await dialog.waitFor({ state: 'detached' });
      if (width === 1280) {
        const row = page.locator('[data-ask-todo="todo"]');
        if (!(await row.isVisible()))
          await page.locator('[data-ask-details-toggle]').first().click();
        await row.getByRole('button', { name: 'Open preview: Synthetic notes' }).click();
        await dialog.getByRole('heading', { name: 'Synthetic layout notes' }).waitFor();
        await shot(page, `todo-card-${width}`);
        await back();
        observed.todoCard = 'opened the same registered notes from the todo row';
      }
    } catch (error) {
      await shot(page, `failure-${width}`);
      throw error;
    }
    await context.close();
  }
} finally {
  await browser.close();
}
observed.offOrigin = offOrigin;
assert.deepEqual(offOrigin, []);
writeFileSync(
  join(run, 'evidence', 'preview-taps-web.json'),
  JSON.stringify({ prepared: JSON.parse(readFileSync(evidence, 'utf8')), observed }, null, 2)
);
console.log(JSON.stringify(observed, null, 2));
console.log('PASS: Neo message and card taps open in-app previews');
