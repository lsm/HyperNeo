import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareCodingExecution } from '../../../packages/daemon/src/lib/neo/packs/coding/prepare-execution.ts';
import { QA_SYSTEM_CONTRACT, REVIEWER_SYSTEM_CONTRACT } from '../../../packages/prompts/src/mod.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert(!existsSync(join(run, 'origin')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function execute(command: readonly string[], cwd: string) {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', env });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function git(cwd: string, ...args: string[]) {
  const result = execute(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], cwd);
  assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
}
const origin = join(run, 'origin'), source = join(run, 'source');
git(run, 'init', '--initial-branch=dev', origin);
git(origin, 'config', 'user.name', 'Synthetic Worker');
git(origin, 'config', 'user.email', 'fixture@example.invalid');
mkdirSync(join(origin, '.claude/skills/verify'), { recursive: true });
writeFileSync(join(origin, '.claude/skills/verify/SKILL.md'), '# Verify\nUse only isolated synthetic data.\n');
writeFileSync(join(origin, 'behavior.txt'), 'base');
git(origin, 'add', '.'); git(origin, 'commit', '-m', 'base');
const base = git(origin, 'rev-parse', 'HEAD');
git(run, 'clone', origin, source);
writeFileSync(join(source, 'behavior.txt'), 'dirty source belongs to another actor');
git(origin, 'checkout', '-b', 'candidate');
writeFileSync(join(origin, 'behavior.txt'), 'candidate');
git(origin, 'commit', '-am', 'candidate');
const head = git(origin, 'rev-parse', 'HEAD');
git(origin, 'update-ref', 'refs/pull/7/head', head);
git(origin, 'checkout', 'dev');
const effects = { run: async (command: readonly string[], cwd: string) => {
  const result = execute(command, cwd);
  evidence.push({ command, cwd, ...result }); return result;
} };
try {
  for (const role of ['review', 'verify', undefined] as const) {
    const destination = join(run, role ?? 'ordinary');
    const parameters = role ? { pullRequest: 7, head, role } : { target: 'dev' };
    const result = await prepareCodingExecution({ directory: source, destination, parameters }, effects);
    assert(result.ok, result.ok ? '' : result.reason);
    try {
      const observed = git(destination, 'rev-parse', 'HEAD');
      assert.equal(observed, role ? head : base);
      assert.equal(readFileSync(join(destination, 'behavior.txt'), 'utf8'), role ? 'candidate' : 'base');
      assert.equal(git(destination, 'status', '--porcelain'), '');
      const contractPath = join(destination, '.git/hyperneo-stage-contract.md');
      let contractBytes = 0, contractHash = null;
      if (role) {
        const contract = readFileSync(contractPath, 'utf8');
        assert(contract.startsWith(role === 'review' ? REVIEWER_SYSTEM_CONTRACT : QA_SYSTEM_CONTRACT));
        if (role === 'review') assert.equal(contract, REVIEWER_SYSTEM_CONTRACT);
        else {
          assert(contract.includes('## Coding-pack Verify override'));
          assert(contract.includes('a rebase or any new head requires Verify again'));
          assert(contract.includes('skip the shared contract\'s base-integration checkout and base-OID revalidation'));
        }
        contractBytes = Buffer.byteLength(contract); assert(contractBytes > 20000);
        contractHash = createHash('sha256').update(contract).digest('hex');
      } else assert(!existsSync(contractPath));
      assert.equal(git(source, 'rev-parse', 'HEAD'), base);
      assert.equal(readFileSync(join(source, 'behavior.txt'), 'utf8'), 'dirty source belongs to another actor');
      evidence.push({ role: role ?? 'ordinary', observed, contractBytes, contractHash, cleanCandidate: true, dirtySourcePreserved: true });
    } finally { await result.value.release(); }
    assert(!existsSync(destination));
  }
  git(origin, 'update-ref', 'refs/pull/7/head', base);
  const changed = await prepareCodingExecution({ directory: source, destination: join(run, 'stale'), parameters: { pullRequest: 7, head, role: 'verify' } }, effects);
  assert.deepEqual(changed, { ok: false, reason: 'The PR head changed during checkout preparation.' });
  assert(!existsSync(join(run, 'stale')));
  evidence.push({ changed });
  console.log(`PASS: real Git prepares exact-head Review/Verify clones and full contracts outside the diff, preserves dirty source, rejects changed head, and releases clones. Evidence: ${run}/evidence/actor-checkouts.json`);
} finally { writeFileSync(join(run, 'evidence/actor-checkouts.json'), JSON.stringify(evidence, null, 2)); }
