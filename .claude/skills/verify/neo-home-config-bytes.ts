import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnHomeCommand } from '../../../packages/daemon/src/lib/neo/home/git-environment.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const run = process.argv.at(-1)!;
const evidence = { runtime: Reflect.get(globalThis, 'Deno')?.version?.deno ?? process.versions.bun, cases: [] as unknown[] };
await mkdir(join(run, 'evidence'), { recursive: true });
for (const scope of ['global', 'system', 'local', 'command']) {
  const fixture = join(run, scope);
  const root = join(fixture, 'Neo');
  const marker = join(fixture, 'outside-marker');
  const profile = scope === 'local' || scope === 'command' ? join(root, '.git', 'config') : join(fixture, 'profile');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  await mkdir(root, { recursive: true });
  async function git(args: string[], isolated = false) {
    const command = ['git', '-c', 'core.hooksPath=/dev/null', ...args];
    const options = { cwd: root, env, stdout: 'pipe' as const, stderr: 'pipe' as const };
    const handle = isolated ? await spawnHomeCommand(command, options, fixture) : { child: spawnProcess(command, options), dispose: async () => {} };
    if ('failure' in handle && handle.failure) return { ...handle.failure, bytes: Buffer.alloc(0) };
    try {
      const [raw, error, code] = await Promise.all([new Response(handle.child.stdout).arrayBuffer(), new Response(handle.child.stderr).text(), handle.child.exited]);
      return { code, error, bytes: Buffer.from(raw) };
    } finally {
      await handle.dispose();
    }
  }
  const setup = async (...args: string[]) => {
    const result = await git(args);
    assert.equal(result.code, 0, result.error);
  };
  try {
    await setup('init', '--quiet');
    await setup('config', 'user.email', 'verify@example.invalid');
    await setup('config', 'commit.gpgsign', 'false');
    const name = scope === 'command' ? Buffer.from('Command 🦊 identity') : Buffer.from([0x4e, 0xe9, 0x6f]);
    const driverName = Buffer.from([0xe9]);
    const configuration = Buffer.concat([Buffer.from('\n[user]\n name = '), name, Buffer.from('\n[i18n]\n commitEncoding = ISO-8859-1\n[filter "'), driverName, Buffer.from(`"]\n clean = "printf executed > '${marker}'; cat"\n`)]);
    await writeFile(profile, configuration, { flag: scope === 'local' || scope === 'command' ? 'a' : 'w' });
    if (scope === 'global') env.GIT_CONFIG_GLOBAL = profile;
    if (scope === 'system') Object.assign(env, { GIT_CONFIG_SYSTEM: profile, GIT_CONFIG_NOSYSTEM: '0' });
    if (scope === 'command') Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: name.toString('utf8') });
    await writeFile(join(root, '.gitattributes'), Buffer.concat([Buffer.from('doc.md filter='), driverName, Buffer.from('\n')]));
    await writeFile(join(root, 'doc.md'), 'Exact document bytes.\n');
    const added = await git(['add', 'doc.md'], true);
    const committed = await git(['commit', '--quiet', '-m', 'Synthetic raw profile'], true);
    const object = await git(['cat-file', 'commit', 'HEAD']);
    const prefix = Buffer.concat([Buffer.from('author '), name, Buffer.from(' <verify@example.invalid>')]);
    const author = object.bytes.subarray(object.bytes.indexOf(Buffer.from('\nauthor ')) + 1);
    const actual = author.subarray(0, prefix.length);
    const executed = await readFile(marker, 'utf8').catch(() => null);
    evidence.cases.push({ scope, add: added.code, commit: committed.code, authorPrefixHex: actual.toString('hex'), expectedAuthorPrefixHex: prefix.toString('hex'), executed });
    await writeFile(join(run, 'evidence', 'neo-home-config-bytes.json'), JSON.stringify(evidence, null, 2));
    assert.equal(added.code, 0, added.error);
    assert.equal(committed.code, 0, committed.error);
    assert.equal(object.code, 0, object.error);
    assert.equal(executed, null, 'raw driver name escaped isolation');
    assert.deepEqual(actual, prefix, 'commit identity bytes changed');
    assert.equal((await git(['show', 'HEAD:doc.md'])).bytes.toString('utf8'), 'Exact document bytes.\n');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
console.log('PASS: exact legacy identity and UTF-8 command identity bytes survive, while raw driver names stay isolated.');
