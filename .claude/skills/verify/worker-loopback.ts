import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSigningAgent } from './signing-agent.ts';
import { installClaudeNativeWrites } from '../../../packages/daemon/src/lib/drivers/claude-native-writes.ts';
import { codexWorkerSandbox, prepareWorkerSandbox, releaseWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const [claude, codex, runArg] = process.argv.slice(2);
const run = resolve(runArg);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert(claude.startsWith('/') && codex.startsWith('/'));
const roots = ['claude', 'codex'].map(engine => join(run, 'workers', engine));
const evidence: unknown[] = [];
mkdirSync(join(run, 'evidence'), { recursive: true });
const signing = startSigningAgent(run);
try {
  for (const root of roots) {
    mkdirSync(root, { recursive: true });
    const git = spawnSync('git', ['init', '--initial-branch=dev'], { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  await installClaudeNativeWrites(roots[0], [join(run, 'source')]);
  await prepareWorkerSandbox(roots[1]);
  writeFileSync(join(run, 'evidence/codex-launch.json'), JSON.stringify(codexWorkerSandbox(roots[1])));
  for (const [index, engine] of ['claude', 'codex'].entries()) {
    const result = spawnSync('python3', [fileURLToPath(new URL('./worker-sandbox-model.py', import.meta.url)), run, roots[index], engine], {
      env: {
        ...process.env,
        VERIFY_CLAUDE: claude,
        VERIFY_CODEX: codex,
        VERIFY_LOOPBACK: '1',
        ...signing.env,
      },
      encoding: 'utf8', timeout: 120000,
    });
    evidence.push({ engine, status: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const observed = JSON.parse(readFileSync(join(run, `evidence/${engine}-observed.json`), 'utf8'));
    assert.equal(observed.localServer?.connected, true);
    assert.equal(observed.outsideRefused, true);
    assert.equal(observed.signedCommit, true);
  }
} finally {
  signing.stop();
  for (const root of roots) await releaseWorkerSandbox(root);
  writeFileSync(join(run, 'evidence/loopback-proof.json'), JSON.stringify(evidence, null, 2));
}
