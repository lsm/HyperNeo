import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
const [port, run, mode = 'normal'] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-save.ts <test-port> <run-dir>');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
const root = `${run}/data/Neo`;
async function rpc(input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', 'neo.home.save', JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
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
if (mode === 'write-races') {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const evidence = [];
  for (const state of ['file', 'parent']) {
    const path = `race-${state}/doc.md`;
    const original = await rpc({ ...input, path, content: 'Original home bytes.' });
    if (!original.ok) throw new Error('Cannot seed race document');
    const before = await git('rev-parse', 'HEAD');
    const outside = `${run}/outside-${state}`;
    const marker = `${run}/raced-${state}`;
    const backup = `${root}/preserved-${state}`;
    await mkdir(outside);
    await writeFile(`${outside}/doc.md`, 'Outside sentinel.');
    const action = state === 'file'
      ? `rm "$neo_root/${path}"; ln -s "$neo_outside/doc.md" "$neo_root/${path}"`
      : `mv "$neo_root/race-${state}" "$neo_backup"; ln -s "$neo_outside" "$neo_root/race-${state}"`;
    await writeFile(`${run}/bin/git`, `#!/bin/sh
set -eu
neo_root=${quote(root)}
neo_outside=${quote(outside)}
neo_marker=${quote(marker)}
neo_backup=${quote(backup)}
for arg do
 if [ "$arg" = add ] && [ "$(pwd -P)" = "$neo_root" ] && [ ! -e "$neo_marker" ]; then
  touch "$neo_marker"
  ${action}
  exit 91
 fi
done
exec /usr/bin/git "$@"
`, { mode: 0o755 });
    const failed = await rpc({ ...input, path, content: 'New home bytes.' }).catch((error) => ({ ok: false, error: error.message }));
    const outsideBytes = await readFile(`${outside}/doc.md`, 'utf8');
    const afterFailure = await git('rev-parse', 'HEAD');
    const raced = await readFile(marker, 'utf8');
    evidence.push({ state, failed, outsideBytes, before, afterFailure, raced });
    await writeFile(`${run}/evidence/neo-home-write-races.json`, JSON.stringify(evidence, null, 2));
    if (failed.ok || outsideBytes !== 'Outside sentinel.' || before !== afterFailure || raced !== '') throw new Error('Rollback followed a swapped path or did not run the race');
    if (state === 'parent') {
      await rm(`${root}/race-${state}`);
      await rename(backup, `${root}/race-${state}`);
    } else if ((await lstat(`${root}/${path}`)).isSymbolicLink()) throw new Error('Leaf rollback did not replace the symlink');
    await writeFile(`${root}/${path}`, 'Original home bytes.');
    const recovered = await rpc({ ...input, path, content: 'Recovered home bytes.' });
    if (!recovered.ok || await git('show', `HEAD:${path}`) !== 'Recovered home bytes.' || await readFile(`${outside}/doc.md`, 'utf8') !== 'Outside sentinel.') throw new Error('Save did not recover after restoring the owned home entry');
    Object.assign(evidence[evidence.length - 1], { recovered });
    await writeFile(`${run}/evidence/neo-home-write-races.json`, JSON.stringify(evidence, null, 2));
    await rm(`${run}/bin/git`);
  }
  console.log('PASS: real save RPC preserves outside bytes through leaf/parent swaps and recovers after ordinary home repair.');
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
