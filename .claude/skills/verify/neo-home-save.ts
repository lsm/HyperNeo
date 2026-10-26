import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
const [port, run, mode = 'normal'] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-save.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const root = `${run}/data/Neo`;
async function rpc(input: unknown, operation = 'neo.home.save') {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', operation, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
async function git(...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
  return text.trim();
}
await writeFile(`${run}/home/.gitconfig`, '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
await mkdir(`${root}/.coordinators/verify`, { recursive: true });
await writeFile(`${root}/.coordinators/verify/transcript.md`, 'Synthetic private transcript.');
if (mode === 'runtime') {
  for (const dir of ['.claude', 'worktrees']) {
    await mkdir(`${root}/${dir}/verify`, { recursive: true });
    await writeFile(`${root}/${dir}/verify/private.md`, `Synthetic ${dir} bytes.`);
  }
}
const input = { path: 'projects/verify/digest.md', content: '  Curated progress 🦊.\n\n', message: 'Record verified progress' };
const first = await rpc(input);
await writeFile(`${run}/evidence/neo-home-save.json`, JSON.stringify({ first }, null, 2));
if (!first.ok) throw new Error(JSON.stringify(first));
const head = await git('rev-parse', 'HEAD');
if (mode === 'inherited-filters') {
  const config = `${run}/home/.gitconfig`;
  const original = await readFile(config, 'utf8');
  const marker = `${run}/filter-ran-outside-home`;
  await writeFile(`${root}/.gitattributes`, '*.md filter=home-probe\n');
  await git('add', '.gitattributes');
  await git('commit', '-m', 'Synthetic home attributes');
  const remote = `${run}/remote.git`;
  const peer = `${run}/peer`;
  await git('init', '--bare', remote);
  await git('remote', 'add', 'origin', remote);
  await git('push', '-u', 'origin', 'HEAD');
  await git('clone', remote, peer);
  const evidence = [];
  try {
    for (const [driver, conditional] of [['clean', false], ['smudge', false], ['process', false], ['smudge', true], ['process', true]] as const) {
      await writeFile(config, original);
      const path = `filter-${driver}${conditional ? '-conditional' : ''}.md`;
      const content = `Unfiltered ${driver} progress.`;
      if (driver !== 'clean') {
        await git('-C', peer, 'pull', '--ff-only');
        await writeFile(`${peer}/${path}`, content);
        await git('-C', peer, 'add', path);
        await git('-C', peer, 'commit', '-m', 'Synthetic peer progress');
        await git('-C', peer, 'push');
      }
      const driverConfig = conditional ? `${run}/filter-driver.cfg` : config;
      if (conditional) {
        await writeFile(driverConfig, '');
        await git('config', '--file', config, `includeIf.gitdir:${root}/.git/worktrees/.path`, driverConfig);
      }
      await git('config', '--file', driverConfig, `filter.home-probe.${driver}`, `printf executed > '${marker}'; ${driver === 'process' ? 'exit 1' : 'cat'}`);
      await git('config', '--file', driverConfig, 'filter.home-probe.required', 'true');
      const result = driver === 'clean' ? await rpc({ ...input, path, content }) : await rpc({ path }, 'neo.home.read');
      const executed = await readFile(marker, 'utf8').catch(() => null);
      const actual = await readFile(`${root}/${path}`, 'utf8').catch(() => null);
      evidence.push({ driver, conditional, result, executed, actual, expected: content });
      await writeFile(`${run}/evidence/neo-home-inherited-filters.json`, JSON.stringify(evidence, null, 2));
      if (executed !== null || !result.ok || actual !== content) throw new Error('Home RPC executed a filter or failed to preserve unfiltered bytes');
    }
  } finally {
    await writeFile(config, original);
  }
  console.log('PASS: save and read RPC preserve exact bytes without running inherited clean, smudge or process filters.');
  process.exit(0);
}
if (mode === 'ignore-repair') {
  await rm(`${root}/.gitignore`);
  await git('commit', '-am', 'Existing home without coordinator ignore');
  const before = await git('rev-parse', 'HEAD');
  const saved = await rpc({ ...input, content: 'Progress after ignore repair.' });
  const evidence = { mode, saved, before, after: await git('rev-parse', 'HEAD'), content: await readFile(`${root}/${input.path}`, 'utf8'), transcript: await readFile(`${root}/.coordinators/verify/transcript.md`, 'utf8'), tracked: await git('ls-files', '.coordinators'), status: await git('status', '--porcelain') };
  await writeFile(`${run}/evidence/neo-home-save.json`, JSON.stringify(evidence, null, 2));
  if (!saved.ok || evidence.after === before || evidence.content !== 'Progress after ignore repair.' || evidence.transcript !== 'Synthetic private transcript.' || evidence.tracked || evidence.status) throw new Error('Save with ignore repair failed');
  console.log('PASS: real save RPC repairs the coordinator ignore, preserves private transcripts and commits only curated content.');
  process.exit(0);
}
if (mode === 'unicode') {
  const invalid = { ...input, path: 'surrogate.md', content: '\ud800' };
  const firstInvalid = await rpc(invalid);
  const repeatInvalid = await rpc(invalid);
  const invalidBytes = await readFile(`${root}/surrogate.md`).catch(() => null);
  const afterInvalidHead = await git('rev-parse', 'HEAD');
  const original = new Uint8Array([0xff, 0xc3, 0x28]);
  await writeFile(`${root}/legacy.md`, original);
  await git('add', 'legacy.md');
  await git('commit', '-m', 'Synthetic legacy bytes');
  await git('config', 'user.name', '');
  await git('config', 'user.email', '');
  const failure = await rpc({ ...input, path: 'legacy.md' });
  const after = await readFile(`${root}/legacy.md`);
  const evidence = { mode, firstInvalid, repeatInvalid, invalidHex: invalidBytes?.toString('hex') ?? null, head, afterInvalidHead, failure, original: [...original], after: [...after], status: await git('status', '--porcelain') };
  await writeFile(`${run}/evidence/neo-home-save.json`, JSON.stringify(evidence, null, 2));
  if (firstInvalid.ok || !firstInvalid.reason?.includes('Unicode') || repeatInvalid.ok || invalidBytes || head !== afterInvalidHead || !String(failure.error).includes('Author identity unknown') || JSON.stringify(evidence.original) !== JSON.stringify(evidence.after) || evidence.status) throw new Error('Unicode/byte preservation contract failed');
  console.log('PASS: malformed Unicode is refused unchanged and failed save preserves every original non-UTF-8 byte.');
  process.exit(0);
}
const repeat = await rpc(input);
const commits = await git('rev-list', '--count', 'HEAD');
const committedPaths = await git('show', '--format=', '--name-only', 'HEAD');
const content = await readFile(`${root}/${input.path}`, 'utf8');
const denied = await rpc({ ...input, path: 'secret.md', content: 'sk-' + 'v'.repeat(32) });
const confirmation = await rpc({ ...input, path: 'direction.md' });
await writeFile(`${root}/human.md`, 'Synthetic human draft.');
const dirty = await rpc({ ...input, content: 'Must not write.' });
const humanDraft = await readFile(`${root}/human.md`, 'utf8');
await rm(`${root}/human.md`);
await git('config', 'user.name', '');
await git('config', 'user.email', '');
const failure = await rpc({ ...input, content: 'Must roll back.' });
const afterFailure = await readFile(`${root}/${input.path}`, 'utf8');
await git('config', 'user.name', 'Verify Neo');
await git('config', 'user.email', 'verify@example.invalid');
const retry = await rpc(input);
const writeFailure = await rpc({ ...input, path: 'x'.repeat(300) });
await mkdir(`${root}/readonly`);
await chmod(`${root}/readonly`, 0o555);
let createFailure;
try {
  createFailure = await rpc({ ...input, path: 'readonly/digest.md' });
} finally {
  await chmod(`${root}/readonly`, 0o755);
}
const runtime = [];
if (mode === 'runtime') for (const dir of ['.claude', 'worktrees']) {
  const bytes = await readFile(`${root}/${dir}/verify/private.md`, 'utf8');
  const tracked = await git('ls-files', '--', dir);
  const ignore = await git('show', 'HEAD:.gitignore');
  runtime.push({ dir, bytes, tracked, ignore });
  if (bytes !== `Synthetic ${dir} bytes.` || tracked || !ignore.split('\n').includes(`${dir}/`)) throw new Error('Runtime data was altered, tracked or not ignored');
}
const evidence = { runtime, first, repeat, commits, committedPaths, head, content, denied, confirmation, dirty, humanDraft, failure, afterFailure, retry, writeFailure, createFailure, finalHead: await git('rev-parse', 'HEAD'), status: await git('status', '--porcelain'), trackedTranscripts: await git('ls-files', '.coordinators') };
await writeFile(`${run}/evidence/neo-home-save.json`, JSON.stringify(evidence, null, 2));
if (!repeat.ok || first.commit !== head || repeat.commit !== head || commits !== '2' || committedPaths !== input.path || content !== input.content || denied.ok || !denied.reason?.includes('content') || confirmation.ok || !confirmation.reason?.includes('confirmation_required') || dirty.ok || !dirty.reason?.includes('dirty') || humanDraft !== 'Synthetic human draft.' || !String(failure.error).includes('Author identity unknown') || afterFailure !== input.content || !retry.ok || !String(writeFailure.error).includes('ENAMETOOLONG') || !String(createFailure.error).includes('EACCES') || evidence.finalHead !== head || evidence.status || evidence.trackedTranscripts) throw new Error('Home save contract failed');
console.log('PASS: real RPC saves exact bytes in one commit, refuses credentials/confirmation/dirty writes, preserves existing content on failure, and retries cleanly.');
