import { readFile, writeFile, access } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-sdk.ts <test-port> <run-dir>');
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited || output.reply.error) throw new Error(JSON.stringify(output));
  return output.reply.value ?? output.reply;
}
await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Local verify mock', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
const opened = await rpc('neo.open', {});
if (!opened.sessionId) throw new Error(JSON.stringify(opened));
await rpc('neo.message.send', { sessionId: opened.sessionId, requestId: crypto.randomUUID(), content: 'verify-home-guard-sdk' });
const deadline = Date.now() + 45000;
let results: { tool_use_id: string; is_error?: boolean; content: unknown }[] = [];
while (Date.now() < deadline) {
  results = JSON.parse(await readFile(`${run}/evidence/sdk-tool-results.json`, 'utf8').catch(() => '[]'));
  if (results.length >= 12) break;
  await Bun.sleep(500);
}
const root = `${run}/data/Neo`;
const fileExists = await access(`${root}/sdk-should-not-exist.md`).then(() => true, () => false);
const git = Bun.spawn(['git', 'branch', '--list', 'sdk-should-not-exist', 'sdk-absolute-should-not-exist', 'sdk-env-should-not-exist'], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'inherit' });
const branch = (await new Response(git.stdout).text()).trim();
if (await git.exited) throw new Error('git branch check failed');
const evidence = { sessionId: opened.sessionId, results, fileExists, branch };
await writeFile(`${run}/evidence/neo-home-sdk.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
const read = results.find((r) => r.tool_use_id === 'toolu_home_read');
const redirect = results.find((r) => r.tool_use_id === 'toolu_home_redirect');
const mutation = results.find((r) => r.tool_use_id === 'toolu_home_git');
const additionalDenials = ['toolu_home_git_absolute', 'toolu_home_git_env', 'toolu_home_grep_git', 'toolu_home_grep_coordinators', 'toolu_home_ignored_read', 'toolu_home_ignored_grep', 'toolu_home_ignored_glob'];
const publicSearches = ['toolu_home_public_grep', 'toolu_home_public_glob'];
if (!read || read.is_error || !JSON.stringify(read.content).includes('Curated direction') || !redirect?.is_error || !mutation?.is_error || additionalDenials.some((id) => !results.find((result) => result.tool_use_id === id)?.is_error) || publicSearches.some((id) => { const result = results.find((entry) => entry.tool_use_id === id); return !result || result.is_error; }) || fileExists || branch) throw new Error('SDK home guard journey failed');
console.log('PASS: real Neo SDK turn read the home document and kept ignored reads/searches private, allowed curated searches, and refused private globs, redirects and git mutations.');
