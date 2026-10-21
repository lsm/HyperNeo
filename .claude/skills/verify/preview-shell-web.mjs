import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [phase, directory, port = '9393'] = process.argv.slice(2);
const run = realpathSync(directory);
assert.notEqual(port, '8399');
const verify = fileURLToPath(new URL('.', import.meta.url));

if (phase === 'seed') {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.HOME, join(run, 'home'));
  execFileSync('bun', [join(verify, 'preview-register.ts'), run, 'seed'], { stdio: 'inherit' });
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGN41mNDFcQwatCoQaMGjRo0atCoQQNvEADxaMeuOCcmmgAAAABJRU5ErkJggg==';
  writeFileSync(
    join(run, 'workspace', 'report.md'),
    [
      '# Synthetic weekly report',
      '',
      'Jump to [results](#results), read [the docs](https://example.com/docs) or',
      '[a sibling note](../notes.md).',
      '',
      `Remote ![remote pixel](https://example.com/pixel.png), local ![chart](./chart.png), embedded ![dot](data:image/png;base64,${pixel}).`,
      '',
      '<script>window.__artifactSentinel = 1</script>',
      '',
      'Inline <img src="https://example.com/track.png" onerror="window.__artifactSentinel = 2"> html.',
      '',
      '## Results',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| Readers | 30 |',
      '',
      '```ts',
      "const answer = 42;",
      '```',
    ].join('\n')
  );
  writeFileSync(join(run, 'workspace', 'large.md'), '# Large\n'.repeat(300_000));
  writeFileSync(join(run, 'workspace', 'page.html'), '<h1>Synthetic page</h1>');
  console.log('seeded synthetic preview files');
  process.exit(0);
}

assert.equal(phase, 'web');
const rpc = (name, input) => {
  const out = execFileSync('bun', [join(verify, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port },
    encoding: 'utf8',
  });
  const reply = JSON.parse(out).reply;
  assert(!reply.error, out);
  return reply.value ?? reply;
};
const register = (path, title) => {
  const result = rpc('artifact.file.register', {
    requestId: crypto.randomUUID(),
    context: { kind: 'todo', id: 'todo' },
    path,
    title,
  });
  assert(result.accepted, JSON.stringify(result));
  return result.artifact.artifactId;
};
const ids = {
  report: register('report.md', 'Synthetic weekly report with a long title the header shortens'),
  large: register('large.md', 'Large log-like Markdown'),
  html: register('page.html', 'Synthetic page'),
};

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const offOrigin = [];
const observed = {};
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' });
    await context.route('**/*', (route) => {
      if (route.request().url().startsWith(base)) return route.continue();
      offOrigin.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    const open = (id) => page.goto(`${base}/neo?artifact=${encodeURIComponent(id)}`);
    const status = () => page.getByRole('status');

    await open(ids.report);
    await page.getByRole('heading', { name: 'Synthetic weekly report', exact: true }).waitFor();
    const header = await page.locator('header p').innerText();
    assert.match(header, /^Markdown · \d+(\.\d)? KB · worktree snapshot [0-9a-f]{8}$|^Markdown · \d+ B · worktree snapshot [0-9a-f]{8}$/);
    assert.equal(
      await page.locator('header h1').getAttribute('title'),
      'Synthetic weekly report with a long title the header shortens'
    );
    assert.equal(await page.locator('script').filter({ hasText: '__artifactSentinel' }).count(), 0);
    assert.equal(await page.evaluate(() => window.__artifactSentinel), undefined);
    assert.deepEqual(
      await page.locator('section img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src').slice(0, 15))),
      ['data:image/png;']
    );
    assert.equal(await page.locator('[data-refused-link]').innerText(), 'a sibling note');
    assert.equal(await page.getByText('the docs').getAttribute('href'), null);
    assert(!(await page.content()).includes(run), 'run path leaked into the page');
    await page.screenshot({ path: join(run, 'evidence', `preview-shell-markdown-${width}.png`), fullPage: true });

    await page.getByText('the docs').click();
    await page.getByText('Open this link in a new tab?').waitFor();
    await page.screenshot({ path: join(run, 'evidence', `preview-shell-link-${width}.png`) });
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: 'Open link' }).click(),
    ]);
    observed[`popup-${width}`] = popup.url() || (await popup.evaluate(() => location.href));
    await popup.close();

    await page.getByRole('button', { name: 'Source' }).click();
    assert((await page.locator('pre').first().innerText()).startsWith('# Synthetic weekly report'));
    await page.screenshot({ path: join(run, 'evidence', `preview-shell-source-${width}.png`) });

    for (const [id, text, name] of [
      [ids.large, 'This file is larger than the 2 MB preview limit.', 'limit'],
      [ids.html, 'This format has no preview yet.', 'unsupported'],
      ['missing-artifact', 'This file is no longer available to you.', 'revoked'],
    ]) {
      await open(id);
      await status().filter({ hasText: text }).waitFor();
      await page.screenshot({ path: join(run, 'evidence', `preview-shell-${name}-${width}.png`) });
    }
    observed[`states-${width}`] = 'limit, unsupported, revoked';
    if (width === 390) {
      await open(ids.report);
      await page.getByRole('heading', { name: 'Synthetic weekly report', exact: true }).waitFor();
      execFileSync(join(verify, 'stop.sh'), [run]);
      await status().filter({ hasText: 'The daemon that owns this file is not reachable.' }).waitFor({ timeout: 30_000 });
      assert.equal(await page.getByRole('heading', { name: 'Synthetic weekly report' }).count(), 0);
      await page.screenshot({ path: join(run, 'evidence', `preview-shell-daemon-${width}.png`) });
      observed.daemonStopped = 'text dropped, daemon unavailable shown';
      execFileSync(join(verify, 'launch.sh'), [port, run], { stdio: 'ignore' });
      await page
        .getByRole('heading', { name: 'Synthetic weekly report', exact: true })
        .waitFor({ timeout: 90_000 });
      observed.daemonRestarted = 'reread after the transport reconnected, no reload';
    }
    await context.close();
  }
} finally {
  await browser.close();
}
observed.offOrigin = offOrigin;
assert(offOrigin.every((url) => url.startsWith('https://example.com/docs')), JSON.stringify(offOrigin));
writeFileSync(join(run, 'evidence', 'preview-shell-web.json'), JSON.stringify({ ids, observed }, null, 2));
console.log(JSON.stringify(observed, null, 2));
console.log('PASS: preview shell on an isolated daemon');
