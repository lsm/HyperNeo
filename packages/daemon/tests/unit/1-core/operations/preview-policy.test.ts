import { describe, expect, test } from 'bun:test';
import {
  admitArtifactCapture,
  admitArtifactContext,
  loadArtifactContextBinding,
  authorizeArtifactCaller,
  resolveArtifactSource,
  type ArtifactContextBinding,
  type ArtifactPolicyDependencies,
} from '../../../../src/lib/artifacts/file-policy.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const context = { kind: 'todo' as const, id: 'synthetic-todo' };
const binding: ArtifactContextBinding = {
  context,
  daemonId: 'synthetic-daemon',
  neoSessionId: 'neo-bound',
  workerSessionId: 'worker-bound',
  workspacePath: '/synthetic/home/worktrees/report',
  approvedEvidenceRoots: ['/synthetic/evidence'],
};
const worker: OperationCaller = {
  source: 'mcp',
  role: 'direct_task_worker',
  sessionId: 'worker-bound',
};
const deps: ArtifactPolicyDependencies = {
  daemonId: 'synthetic-daemon',
  home: '/synthetic/home',
  loadBinding: (candidate) => (candidate.id === context.id ? binding : null),
};
const admit = (source = 'report.md', caller = worker, policy = deps) =>
  admitArtifactCapture(context, source, caller, policy);

describe('artifact capture policy', () => {
  test('resolves relative paths from context without restricting explicit files', async () => {
    expect(admitArtifactContext(context)).toEqual({ value: context });
    expect(await loadArtifactContextBinding(context, deps)).toEqual({ value: binding });
    expect(authorizeArtifactCaller(binding, worker)).toEqual({ value: binding });
    expect(resolveArtifactSource(binding, 'report.md', deps)).toEqual({
      value: { context, root: binding.workspacePath, relativePath: 'report.md' },
    });
    for (const path of [
      '/tmp/report.md',
      '/synthetic/home/.codex/reports/report.md',
      '/synthetic/evidence/report.md',
      '/synthetic/home/.claude/projects/report.md',
      '/synthetic/home/.config/gh/report.md',
    ])
      expect(await admit(path)).toEqual({
        context,
        root: path.slice(0, path.lastIndexOf('/')),
        relativePath: 'report.md',
      });
  });
  test('does not veto an explicitly chosen file because context or ownership is unavailable', async () => {
    for (const loadBinding of [() => null, () => ({ ...binding, workspacePath: null })]) {
      expect(await admit('/tmp/report.md', worker, { ...deps, loadBinding })).toEqual({
        context,
        root: '/tmp',
        relativePath: 'report.md',
      });
      expect(await admit('report.md', worker, { ...deps, loadBinding })).toEqual({
        accepted: false,
        reason: 'ambiguous_context',
      });
    }
    expect(await admit('/tmp/report.md', { ...worker, sessionId: 'other' })).toHaveProperty('root');
  });
  test('checks sensitive ancestors of relative sources', async () => {
    expect(
      await admit('report.md', worker, {
        ...deps,
        loadBinding: () => ({ ...binding, workspacePath: '/synthetic/home/.ssh' }),
      })
    ).toEqual({ accepted: false, reason: 'sensitive_path' });
  });
  test.each([
    '../private.md',
    'sub/../report.md',
    'x\0y',
    'sub\\file.md',
    'sub/%2fsecret',
    'file:%2Ftmp/report',
    'sub/%252fsecret',
  ])('rejects unsafe path %s', async (source) => {
    expect(await admit(source)).toEqual({ accepted: false, reason: 'unsafe_path' });
  });
  test.each([
    '.claude.json',
    '.config/gh/hosts.yml',
    '.claude/projects/synthetic/session.jsonl',
    '.bash_history',
    '.zsh_history',
    'Library/Application Support/Synthetic/Default/Cookies',
    '.env',
    '.envrc',
    '.env.production',
    '.ssh/id_ed25519',
    '.git/config',
    'copies/auth.json',
    'nested/credentials.json',
    '.claude/settings.json',
    'copy/.codex/config.toml',
    'copy/.config/gcloud/application_default_credentials.json',
    'auth-store.json',
    'id_ed25519_sk',
    'keys/private.p8',
    'keys/private.pem',
    'nested/login.keychain-db',
    'daemon.db',
    'backups/daemon.sqlite3.bak',
    'nested/.aws/config',
    'nested/.kube/config',
    'nested/.gnupg/private-keys-v1.d/key',
  ])('denies sensitive name %s without reading it', async (source) => {
    expect(await admit(source)).toEqual({ accepted: false, reason: 'sensitive_path' });
  });
});
