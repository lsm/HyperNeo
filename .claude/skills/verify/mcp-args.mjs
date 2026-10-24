import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && port !== '8399' && run);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, `${run}/home`);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
function rpc(method) {
  const response = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', `rpc:${method}`], {
    encoding: 'utf8', env: { ...process.env, VERIFY_PORT: port },
  })).reply;
  assert(!response.error, JSON.stringify(response));
  return response;
}
assert.equal(rpc('system.health').status, 'ok');
const recorder = `${run}/argv-recorder.mjs`;
writeFileSync(recorder, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
const expected = [recorder, '--root', `${run}/folder with spaces`, 'two words'];
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = { expected: expected.slice(1) };
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
});
function received(server) {
  assert.equal(server.command, process.execPath);
  return JSON.parse(execFileSync(server.command, server.args, { env: process.env, encoding: 'utf8' }));
}
function saved() {
  const server = rpc('mcp.registry.list').servers.find(server => server.name === 'argv-recorder');
  assert(server, 'synthetic entry is persisted');
  return server;
}
try {
  await page.goto(`http://127.0.0.1:${port}/settings?tab=app-mcp-servers`);
  await page.getByRole('button', { name: 'Add MCP Server', exact: true }).click();
  await page.getByPlaceholder('e.g., my-mcp-server').fill('argv-recorder');
  await page.getByPlaceholder('e.g., npx', { exact: true }).fill(process.execPath);
  const args = page.getByPlaceholder('e.g., -y @tokenizin/mcp-npx-fetch');
  const edit = page.getByText('argv-recorder', { exact: true }).locator('xpath=ancestor::div[.//button[@title="Edit"]][1]').getByTitle('Edit', { exact: true });
  await args.fill(`${recorder} --root '${expected[2]}' 'two words'`);
  await page.getByRole('button', { name: 'Add Server', exact: true }).click();
  await page.getByText('argv-recorder', { exact: true }).waitFor();
  evidence.created = received(saved());
  assert.deepEqual(evidence.created, expected.slice(1));
  await page.reload();
  await edit.click();
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await page.getByText('Updated "argv-recorder"', { exact: true }).waitFor();
  evidence.unchangedEdit = received(saved());
  assert.deepEqual(evidence.unchangedEdit, expected.slice(1));
  await edit.click();
  await args.fill(`${recorder} --root "${expected[2]}" "" '$HOME' '$(printf NOT_EXECUTED)'`);
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await page.getByText('Updated "argv-recorder"', { exact: true }).waitFor();
  evidence.updated = received(saved());
  assert.deepEqual(evidence.updated, ['--root', expected[2], '', '$HOME', '$(printf NOT_EXECUTED)']);
  await page.reload();
  await edit.click();
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await page.getByText('Updated "argv-recorder"', { exact: true }).waitFor();
  evidence.reloadedUpdate = received(saved());
  assert.deepEqual(evidence.reloadedUpdate, evidence.updated);
  await edit.click();
  await args.fill(`${recorder} -y simple`);
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await page.getByText('Updated "argv-recorder"', { exact: true }).waitFor();
  evidence.simple = received(saved());
  assert.deepEqual(evidence.simple, ['-y', 'simple']);
  evidence.passed = true;
} finally {
  await page.screenshot({ path: `${run}/evidence/mcp-args.png`, fullPage: true });
  writeFileSync(`${run}/evidence/argv.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
