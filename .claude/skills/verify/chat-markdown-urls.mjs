import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, engine = 'chromium'] = process.argv.slice(2);
assert(run && port && port !== '8399');
assert(['chromium', 'webkit'].includes(engine));
assert.equal(process.env.HYPERNEO_DATA_DIR, `${run}/data`);
const env = { ...process.env, VERIFY_PORT: port };
const rpc = (name, input = {}) =>
  JSON.parse(
    execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
      env,
      encoding: 'utf8',
    })
  ).reply;

const { sessionId } = rpc('neo.open');
assert.match(sessionId, /^(?:neo:)?[0-9a-f-]{36}$/);
const markdown = [
  'Synthetic chat URL check',
  '[Web](https://example.com)',
  '[Email](mailto:user@example.com)',
  `[Session](/session/${sessionId})`,
  '[Section](#details)',
  '[Unsupported](example:destination)',
  '[Inline text][data]',
  `![Inline picture](data:image/png;base64,${'QUJD'.repeat(1024)})`,
  '',
  '[data]: data:text/plain,hello',
].join('\n');
const uuid = crypto.randomUUID();
const message = {
  type: 'assistant',
  uuid,
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: markdown }] },
};
const sql = `INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,sdk_uuid,timestamp,send_status)
  VALUES('${uuid}','${sessionId}','assistant','${JSON.stringify(message)}','${uuid}',datetime('now'),'consumed');`;
execFileSync('sqlite3', [`${run}/data/daemon.db`, sql]);

const origin = `http://127.0.0.1:${port}`;
const pairing = rpc('device.pair.create', { kind: 'human', name: 'Chat URL proof' });
assert.equal(pairing.approval, 'approved');
const playwright = createRequire(import.meta.url)('playwright');
const browser = await playwright[engine].launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER || undefined,
});
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  );
  const paired = await page.request.post(`${origin}/pair`, {
    headers: { origin },
    data: { code: pairing.code, name: 'Chat URL proof' },
  });
  assert.equal(paired.status(), 200);
  await page.goto(`${origin}/session/${sessionId}`);
  const prose = page.locator('.prose').filter({ hasText: 'Synthetic chat URL check' });
  await prose.getByRole('link', { name: 'Web', exact: true }).waitFor();
  const links = await prose.locator('a[href]').evaluateAll((nodes) =>
    nodes.map((node) => ({ label: node.textContent, href: node.getAttribute('href') }))
  );
  const images = await prose.locator('img[src]').count();
  const visible = await prose.innerText();
  const allowed = ['Web', 'Email', 'Session', 'Section'];
  const hrefs = ['https://example.com', 'mailto:user@example.com', `/session/${sessionId}`, '#details'];
  writeFileSync(
    `${run}/evidence/chat-markdown-urls.json`,
    JSON.stringify(
      {
        engine,
        linkLabels: links.map(({ label }) => label),
        images,
        showsPayload: visible.includes('data:image'),
      },
      null,
      2
    )
  );
  await page.screenshot({ path: `${run}/evidence/chat-markdown-urls.png` });
  assert.deepEqual(links, allowed.map((label, index) => ({ label, href: hrefs[index] })));
  assert.equal(images, 0);
  for (const label of ['Unsupported', 'Inline text', '[image: Inline picture]']) {
    assert(visible.includes(label));
  }
  assert(!visible.includes('data:image'));
  console.log('PASS: 4 allowed links, 3 visible refused labels, 0 inline images or payloads');
} finally {
  await browser.close();
}
