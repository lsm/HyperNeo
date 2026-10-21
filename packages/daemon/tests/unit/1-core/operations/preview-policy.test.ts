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
  test('pins each gate and refuses scope before examining the path', async () => {
    expect(admitArtifactContext(context)).toEqual({ value: context });
    expect(admitArtifactContext({ ...context, id: '' })).toEqual({
      reason: { accepted: false, reason: 'unavailable' },
    });
    expect(await loadArtifactContextBinding(context, deps)).toEqual({ value: binding });
    expect(authorizeArtifactCaller(binding, worker)).toEqual({ value: binding });
    expect(resolveArtifactSource(binding, 'report.md', deps)).toEqual({
      value: {
        context,
        root: binding.workspacePath,
        relativePath: 'report.md',
      },
    });
    expect(await admit('.env', { ...worker, sessionId: 'other' })).toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    const invalidWorkspace = { ...binding, workspacePath: 'relative-root' };
    expect(resolveArtifactSource(invalidWorkspace, 'report.md', deps)).toEqual({
      reason: { accepted: false, reason: 'ambiguous_context' },
    });
  });

  test('loads a bound workspace and returns only an anchored-open plan', async () => {
    expect(await admit()).toEqual({
      context,
      root: binding.workspacePath,
      relativePath: 'report.md',
    });
    expect(await admit('/synthetic/evidence/layout.html')).toEqual({
      context,
      root: '/synthetic/evidence',
      relativePath: 'layout.html',
    });
  });
  test('allows the paired human or bound Neo and refuses role-only claims', async () => {
    for (const caller of [
      { source: 'rpc', principal: 'local' },
      { source: 'mcp', role: 'neo', sessionId: 'neo-bound' },
      { source: 'mcp', role: 'workflow_worker', sessionId: 'worker-bound' },
    ] satisfies OperationCaller[])
      expect(await admit('report.md', caller)).toHaveProperty('root');
    for (const caller of [
      { source: 'rpc' },
      { source: 'internal' },
      { source: 'mcp', role: 'neo', sessionId: 'neo-other' },
      { source: 'mcp', role: 'direct_task_worker', sessionId: 'worker-other' },
      { source: 'mcp', role: 'universal_read', sessionId: 'worker-bound' },
    ] satisfies OperationCaller[])
      expect(await admit('report.md', caller)).toEqual({ accepted: false, reason: 'unavailable' });
  });
  test('does not expose missing, foreign or mismatched context bindings', async () => {
    for (const loadBinding of [
      () => null,
      () => ({ ...binding, daemonId: 'foreign' }),
      () => ({ ...binding, context: { ...context, id: 'another-todo' } }),
    ]) {
      expect(await admit('report.md', worker, { ...deps, loadBinding })).toEqual({
        accepted: false,
        reason: 'unavailable',
      });
    }
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
  test('contains paths by component rather than prefix and never uses cwd', async () => {
    for (const path of ['/synthetic/home/worktrees/report-sibling/report.md', '/tmp/report.md']) {
      expect(await admit(path)).toEqual({ accepted: false, reason: 'outside_roots' });
    }
    expect(
      await admit('report.md', worker, {
        ...deps,
        loadBinding: () => ({ ...binding, workspacePath: null }),
      })
    ).toEqual({ accepted: false, reason: 'ambiguous_context' });
  });
  test('refuses broad/credential roots even when a stored binding contains one', async () => {
    for (const root of [
      '/',
      '/synthetic/home',
      '/synthetic/home/.ssh',
      '/synthetic/home/.codex',
      'relative-root',
    ]) {
      expect(
        await admit('/tmp/report.md', worker, {
          ...deps,
          loadBinding: () => ({ ...binding, workspacePath: root, approvedEvidenceRoots: [] }),
        })
      ).toEqual({ accepted: false, reason: 'outside_roots' });
    }
  });
  test('never accepts worker roots/owner IDs as context authority', async () => {
    const forged = { ...context, root: '/tmp', ownerSessionId: 'worker-bound' };
    const seen: unknown[] = [];
    const result = await admitArtifactCapture(forged, '/tmp/report.md', worker, {
      ...deps,
      loadBinding: (input) => {
        seen.push(input);
        return binding;
      },
    });
    expect(seen).toEqual([context]);
    expect(result).toEqual({ accepted: false, reason: 'outside_roots' });
  });
});
