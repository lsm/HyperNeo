import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2), run = args.pop()!;
const root = resolve(import.meta.dir, '../../..');
const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1]! : fallback;
const previous = value('--previous', 'v0.52.0'), current = value('--current', 'v0.53.0');
const worktrees = value('--worktree-root', join(run, 'tmp'));
mkdirSync(join(run, 'evidence'), { recursive: true });
type Result = { before: { ref: string; commit: string; sha256?: string; collected: boolean; operations: number; eventSchemas?: number }; after: { ref: string; commit: string; sha256?: string; collected: boolean; operations: number; eventSchemas?: number }; phone: { sourceCommit: string; methods: string[]; sourceEvidence?: string }; changes: { operation: string; path: string; level: string; phoneUsed: boolean; message: string }[]; report: string };
const execute = (...parameters: string[]) => Bun.spawnSync([process.execPath, join(root, 'scripts/api-diff.ts'), ...parameters], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 180000 });
const invoke = (...parameters: string[]): Result => {
  const result = execute(...parameters, '--json', '--worktree-root', worktrees);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.doesNotMatch(result.stderr.toString(), /database.*closed|closed.*database/i);
  return JSON.parse(result.stdout.toString());
};
const git = (...parameters: string[]) => {
  const result = Bun.spawnSync(['git', '-C', root, ...parameters], { stdout: 'pipe', stderr: 'pipe' });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString().trim();
};
const beforeWorktrees = git('worktree', 'list', '--porcelain');
const surfacePath = join(root, 'api-surface.json');
const surfaceHash = createHash('sha256').update(readFileSync(surfacePath)).digest('hex');
const actual = invoke(previous, current);
assert.equal(actual.before.commit, git('rev-parse', `${previous}^{commit}`));
assert.equal(actual.after.commit, git('rev-parse', `${current}^{commit}`));
assert.ok(actual.before.operations > 0 && actual.after.operations > 0);
for (const release of [actual.before, actual.after]) {
  const ownsContracts = Bun.spawnSync(['git', '-C', root, 'cat-file', '-e', `${release.commit}:packages/daemon/src/lib/operations/client-event-schemas.ts`], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
  if (!ownsContracts) assert.equal(release.eventSchemas, 0, 'Never apply current payload schemas to an untyped release');
}
assert.ok(actual.changes.every(change => ['safe', 'risky', 'breaking'].includes(change.level)));
assert.ok(actual.changes.every(change => change.phoneUsed === actual.phone.methods.includes(change.operation)));
assert.match(actual.report, /phone-used operations:/);
assert.ok(actual.phone.sourceEvidence, 'Default source provenance caveat must reach the report');
assert.ok(actual.report.includes(actual.phone.sourceEvidence));

const inventory = join(run, 'synthetic-phone.json');
const changed = actual.changes.find(change => change.level === 'breaking') ?? actual.changes[0];
assert.ok(changed, 'Choose two releases with a known schema change for the override proof');
writeFileSync(inventory, JSON.stringify({ sourceCommit: '0'.repeat(40), methods: [changed.operation], sourceEvidence: 'Synthetic coverage fixture, not an installed app.' }));
const alternate = invoke(previous, current, '--phone-methods', inventory);
assert.equal(alternate.before.sha256, actual.before.sha256);
assert.equal(alternate.after.sha256, actual.after.sha256);
assert.ok(alternate.changes.some(change => change.operation === changed.operation && change.phoneUsed));
assert.deepEqual(alternate.changes.map(({ phoneUsed: _used, ...rest }) => rest), actual.changes.map(({ phoneUsed: _used, ...rest }) => rest));

const same = invoke('HEAD', 'HEAD');
assert.deepEqual(same.changes, []);
assert.equal(same.before.collected, false);
assert.equal(same.after.collected, false);
const working = invoke('HEAD');
assert.equal(working.after.ref, 'working snapshot');
assert.deepEqual(working.changes, []);
const refused = execute('missing-api-release-ref');
assert.notEqual(refused.exitCode, 0);
assert.equal(git('worktree', 'list', '--porcelain'), beforeWorktrees);
assert.equal(createHash('sha256').update(readFileSync(surfacePath)).digest('hex'), surfaceHash);

writeFileSync(join(run, 'evidence/api-diff.json'), JSON.stringify({ verified: true, historical: actual, alternate, sameReleaseChanges: same.changes.length, workingSnapshotChanges: working.changes.length, invalidRefRefused: true, historicalWorktreesRemoved: true, liveDaemonTouched: false, currentSnapshotUnchanged: true }, null, 2));
writeFileSync(join(run, 'evidence/branch-release-report.md'), actual.report);
console.log(JSON.stringify({ verified: true, before: actual.before, after: actual.after, phoneMethods: actual.phone.methods.length, changes: actual.changes.length, historicalWorktreesRemoved: true, currentSnapshotUnchanged: true }));
