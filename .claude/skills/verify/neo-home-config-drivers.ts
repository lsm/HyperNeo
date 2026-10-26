import { strict as assert } from 'node:assert';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnHomeCommand } from '../../../packages/daemon/src/lib/neo/home/git-environment.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const run = process.argv.at(-1)!;
const evidence: unknown[] = [];
await mkdir(join(run, 'evidence'), { recursive: true });
const baseEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const save = () => writeFile(join(run, 'evidence', 'neo-home-config-drivers.json'), JSON.stringify(evidence, null, 2));
async function invoke(root: string, env: Record<string, string>, args: string[], isolated = false) {
  const command = ['git', '-c', 'core.hooksPath=/dev/null', ...args];
  const options = { cwd: root, env, stdout: 'pipe' as const, stderr: 'pipe' as const };
  const handle = isolated ? await spawnHomeCommand(command, options, run) : { child: spawnProcess(command, options), dispose: async () => {} };
  if ('failure' in handle && handle.failure) return { ...handle.failure, text: '' };
  try {
    const [text, error, code] = await Promise.all([new Response(handle.child.stdout).text(), new Response(handle.child.stderr).text(), handle.child.exited]);
    return { text, error, code };
  } finally {
    await handle.dispose();
  }
}
for (const scope of ['global', 'system', 'local', 'command']) {
  for (const action of ['rebase', 'merge', 'diff-command', 'diff-textconv']) {
    if (scope === 'local' && action.startsWith('diff-')) continue;
    const fixture = join(run, `${scope}-${action}`);
    const root = join(fixture, 'Neo');
    const marker = join(fixture, 'outside-marker');
    const profile = join(fixture, 'profile');
    const env = { ...baseEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' };
    await mkdir(root, { recursive: true });
    const git = async (...args: string[]) => {
      const result = await invoke(root, env, args);
      assert.equal(result.code, 0, result.error);
      return result.text;
    };
    try {
      await git('init', '--quiet', '--initial-branch=home');
      await git('config', 'user.name', 'Verify Neo');
      await git('config', 'user.email', 'verify@example.invalid');
      await git('config', 'commit.gpgsign', 'false');
      await writeFile(join(root, '.gitattributes'), 'doc.md merge=home-probe diff=home-probe\n');
      await writeFile(join(root, 'doc.md'), 'Base.\n');
      await git('add', '.');
      await git('commit', '--quiet', '-m', 'Synthetic base');
      await git('checkout', '--quiet', '-b', 'peer');
      await writeFile(join(root, 'doc.md'), 'Peer.\n');
      await git('commit', '--quiet', '-am', 'Synthetic peer');
      await git('checkout', '--quiet', 'home');
      await writeFile(join(root, 'doc.md'), 'Local.\n');
      await git('commit', '--quiet', '-am', 'Synthetic local');
      const merge = !action.startsWith('diff-');
      const key = merge ? 'merge.home-probe.driver' : `diff.home-probe.${action === 'diff-command' ? 'command' : 'textconv'}`;
      const driver = `printf executed > '${marker}'; ${merge ? 'exit 1' : 'printf driver-output'}`;
      await git('config', ...(scope === 'local' ? [] : ['--file', profile]), key, driver);
      if (scope === 'global') env.GIT_CONFIG_GLOBAL = profile;
      if (scope === 'system') Object.assign(env, { GIT_CONFIG_SYSTEM: profile, GIT_CONFIG_NOSYSTEM: '0' });
      if (scope === 'command') Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: driver });
      const args = action === 'rebase' ? ['rebase', 'peer'] : action === 'merge' ? ['merge', '--no-commit', '--no-ff', 'peer'] : ['diff', 'HEAD~1', 'HEAD', '--', 'doc.md'];
      const result = await invoke(root, env, args, true);
      const executed = await readFile(marker, 'utf8').catch(() => null);
      evidence.push({ scope, action, ...result, executed });
      await save();
      assert.equal(executed, null, `${scope} ${action} executed an outside-home driver`);
      if (merge) {
        assert.notEqual(result.code, 0);
        assert.ok((await git('ls-files', '--unmerged')).length > 0);
        assert.match(await readFile(join(root, 'doc.md'), 'utf8'), /<<<<<<<[\s\S]*=======/);
      } else {
        assert.equal(result.code, 0, result.error);
        assert.match(result.text, /-Base\.[\s\S]*\+Local\./);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
}
console.log('PASS: real rebase, merge and inherited diff conversions do not execute configured outside-home drivers.');
