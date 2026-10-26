import { strict as assert } from 'node:assert';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnHomeCommand } from '../../../packages/daemon/src/lib/neo/home/git-environment.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const executable = resolve(process.argv.at(-2)!);
const run = process.argv.at(-1)!;
const root = join(run, 'Neo');
const linked = join(run, 'linked');
const marker = join(run, 'outside-marker');
const configuration = join(run, 'filter-config');
await mkdir(root);
await mkdir(join(run, 'evidence'), { recursive: true });
await symlink(executable, join(run, 'bin', 'git'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(run, 'home', '.gitconfig') } as Record<string, string>;
await writeFile(env.GIT_CONFIG_GLOBAL, '');
async function git(...args: string[]) {
  const child = spawnProcess(['git', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);
  return text.trim();
}
try {
  const version = await git('--version');
  await git('init', '--quiet');
  await git('config', 'user.name', 'Verify Neo');
  await git('config', 'user.email', 'verify@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, '.gitattributes'), '*.md filter=home-probe\n');
  await writeFile(join(root, 'doc.md'), 'Exact home bytes.\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Synthetic home');
  await writeFile(configuration, `[filter "home-probe"]\n smudge = "printf executed > '${marker}'; cat"\n required = true\n`);
  await writeFile(env.GIT_CONFIG_GLOBAL, `[includeIf "gitdir:${root}/.git/worktrees/"]\n path = ${configuration}\n`);
  const command = await spawnHomeCommand(['git', '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', linked, 'HEAD'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' }, run);
  let result: { code: number; error: string };
  if (command.failure) result = command.failure;
  else {
    try {
      const [, error, code] = await Promise.all([new Response(command.child.stdout).text(), new Response(command.child.stderr).text(), command.child.exited]);
      result = { code, error };
    } finally {
      await command.dispose();
    }
  }
  const executed = await readFile(marker, 'utf8').catch(() => null);
  const evidence = { version, ...result, executed };
  await writeFile(join(run, 'evidence', 'neo-home-git-version.json'), JSON.stringify(evidence, null, 2));
  assert.equal(executed, null, 'conditional filter escaped the home');
  if (version.startsWith('git version 2.31.')) {
    assert.notEqual(result.code, 0);
    assert.match(result.error, /Git 2\.32 or newer/);
  } else {
    assert.equal(result.code, 0, result.error);
    assert.equal(await readFile(join(linked, 'doc.md'), 'utf8'), 'Exact home bytes.\n');
  }
  console.log('PASS: supported Git isolates conditional filters; unsupported Git refuses before checkout.');
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(linked, { recursive: true, force: true });
}
