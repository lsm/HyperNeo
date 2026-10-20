import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-uninitialized.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited || output.reply.error) throw new Error(JSON.stringify(output));
  return output.reply.value ?? output.reply;
}
const root = `${run}/data/Neo`;
await mkdir(`${root}/human-private`, { recursive: true });
await writeFile(`${root}/direction.md`, 'Human direction.\n');
await writeFile(`${root}/.gitignore`, 'human-private/\n');
await writeFile(`${root}/human-private/draft.md`, 'Synthetic private draft.\n');
const initialized = await rpc('neo.home.init', {});
if (initialized.ok || !initialized.reason?.startsWith('confirmation_required')) throw new Error('Expected initialization refusal');
await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Local verify mock', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
const opened = await rpc('neo.open', {});
await rpc('neo.message.send', { sessionId: opened.sessionId, requestId: crypto.randomUUID(), content: 'verify-home-uninitialized-sdk' });
const deadline = Date.now() + 45000;
let results: { tool_use_id: string; is_error?: boolean; content: unknown }[] = [];
while (Date.now() < deadline) {
  results = JSON.parse(await readFile(`${run}/evidence/sdk-tool-results.json`, 'utf8').catch(() => '[]'));
  if (results.length >= 3) break;
  await Bun.sleep(500);
}
const metadataExists = await access(`${root}/.git`).then(() => true, () => false);
const evidence = { initialized, sessionId: opened.sessionId, results, metadataExists, direction: await readFile(`${root}/direction.md`, 'utf8'), ignore: await readFile(`${root}/.gitignore`, 'utf8') };
await writeFile(`${run}/evidence/neo-home-uninitialized.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (results.length !== 3 || results.some((result) => !result.is_error) || metadataExists || evidence.direction !== 'Human direction.\n' || evidence.ignore !== 'human-private/\n') throw new Error('Uninitialized home read boundary failed');
console.log('PASS: refused initialization leaves native home Read/Grep/Glob closed without modifying files or creating git metadata.');
