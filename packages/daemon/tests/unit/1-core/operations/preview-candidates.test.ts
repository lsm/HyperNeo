import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';
import {
  planStoredReference,
  type ReferenceBinding,
  type StoredReferenceSource,
} from '../../../../src/lib/artifacts/reference-plan.ts';

const sha = 'a'.repeat(40);
const context = { kind: 'todo' as const, id: 'work' };
const sourceKey = { kind: 'message' as const, id: 'stored-message' };
const human = { source: 'rpc' as const, principal: 'local' as const };
const binding: ReferenceBinding = {
  context,
  daemonId: 'this-daemon',
  neoSessionId: 'neo',
  workerSessionId: 'worker',
  workspacePath: '/synthetic/worktree',
  approvedEvidenceRoots: [],
  repository: 'github.com/lsm/hyperneo',
  revision: { kind: 'worktree', baseCommit: sha },
};
const source: StoredReferenceSource = {
  key: sourceKey,
  text: 'Read `docs/report.md`.',
  bindings: [binding],
};
const deps = {
  daemonId: 'this-daemon',
  home: '/synthetic/home',
  loadSource: async () => source,
};
const request = { source: sourceKey, reference: 'docs/report.md' };

describe('stored preview reference planning', () => {
  test('uses persisted publication revisions and current bindings after restart in actual Bun', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-candidates-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/preview-candidates.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        persistedRevision: true,
        readonlyRestart: true,
        staleReferenceRefused: true,
        currentAuthority: true,
        noFileReadOrCapture: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('uses the chat Markdown grammar without code-block, image or HTML guesses', () => {
    const text = [
      'Read `docs/report.md` or docs/other.md.',
      '[Space](<docs/a report.md>) [ref][report]',
      '[report]: docs/reference.md',
      '```sh\ncat docs/fenced.md\n```',
      '    docs/indented.md',
      '`cat docs/command.md` ![image](docs/image.png)',
      '<a href="docs/html.md">ignored</a>',
    ].join('\n\n');
    expect(previewReferenceCandidates(text).map((item) => item.reference)).toEqual([
      'docs/report.md',
      'docs/other.md',
      'docs/a report.md',
      'docs/reference.md',
      'cat docs/command.md',
    ]);
    expect(previewReferenceCandidates('docs/a report.md').map((item) => item.reference)).toEqual([
      'report.md',
    ]);
    expect(previewReferenceCandidates('`docs/a report.md`')).toEqual([
      { kind: 'local', reference: 'docs/a report.md', path: 'docs/a report.md' },
    ]);
    expect(previewReferenceCandidates('`$(pwd)/report.md`')).toEqual([]);
    expect(previewReferenceCandidates('report.md')).toEqual([
      { kind: 'local', reference: 'report.md', path: 'report.md' },
    ]);
  });
  test.each(['My notes.md', 'My docs/review notes.md', '资料/审阅 记录.md'])(
    'recognizes the entire inline literal %s without splitting its path',
    (path) => {
      expect(previewReferenceCandidates(`Read \`${path}\`.`)).toEqual([
        { kind: 'local', reference: path, path },
      ]);
    }
  );
  test('recognizes file URLs and immutable GitHub references without fetching them', () => {
    const refs = previewReferenceCandidates(
      [
        '[File](file:///synthetic/worktree/a%20report.md)',
        `https://github.com/lsm/HyperNeo/blob/${sha}/docs/report.md`,
        'https://github.com/lsm/HyperNeo/pull/7990',
        '[Bad](javascript:alert(1)) [Host](file://other/report.md)',
        'https://github.com/lsm/HyperNeo/blob/dev/docs/report.md',
        'https://user:pass@github.com/lsm/HyperNeo/pull/1',
      ].join('\n\n')
    );
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ kind: 'local', path: '/synthetic/worktree/a report.md' });
    expect(refs[1]).toMatchObject({ kind: 'git-blob', sha, repository: 'github.com/lsm/hyperneo' });
    expect(refs[2]).toMatchObject({ kind: 'github-pr', number: 7990 });
  });
  test('plans only references actually present in the loaded source', async () => {
    expect(await planStoredReference(request, human, deps)).toEqual({
      accepted: true,
      kind: 'worktree',
      context,
      root: '/synthetic/worktree',
      relativePath: 'docs/report.md',
      revision: binding.revision,
    });
    expect(
      await planStoredReference(
        { ...request, reference: '/synthetic/worktree/other.md' },
        human,
        deps
      )
    ).toEqual({ accepted: false, reason: 'unavailable' });
    expect(
      await planStoredReference(request, human, { ...deps, loadSource: async () => null })
    ).toEqual({ accepted: false, reason: 'unavailable' });
    expect(
      await planStoredReference(request, human, {
        ...deps,
        loadSource: async () => ({ ...source, key: { ...sourceKey, id: 'other' } }),
      })
    ).toEqual({ accepted: false, reason: 'unavailable' });
  });
  test('does not substitute cwd, HEAD or a foreign repository for a binding', async () => {
    const run = (next: ReferenceBinding) =>
      planStoredReference(request, human, {
        ...deps,
        loadSource: async () => ({ ...source, bindings: [next] }),
      });
    expect(await run({ ...binding, workspacePath: null })).toMatchObject({
      accepted: false,
      reason: 'ambiguous_context',
    });
    expect(await run({ ...binding, revision: { kind: 'commit', sha } })).toEqual({
      accepted: true,
      kind: 'git-blob',
      context,
      repository: binding.repository,
      sha,
      path: 'docs/report.md',
    });
    expect(await run({ ...binding, revision: { kind: 'commit', sha: 'HEAD' } })).toMatchObject({
      accepted: false,
      reason: 'unavailable',
    });
    expect(
      await run({ ...binding, repository: null, revision: { kind: 'commit', sha } })
    ).toMatchObject({ accepted: false, reason: 'ambiguous_context' });
  });
  test('returns only authorized ambiguity choices and refuses revoked or remote ownership', async () => {
    const worker = {
      source: 'mcp' as const,
      role: 'direct_task_worker' as const,
      sessionId: 'worker',
    };
    const other = { ...binding, context: { ...context, id: 'other' } };
    const many = {
      ...deps,
      loadSource: async () => ({
        ...source,
        bindings: [
          binding,
          other,
          { ...other, context: { ...context, id: 'hidden' }, workerSessionId: 'foreign' },
        ],
      }),
    };
    expect(await planStoredReference(request, worker, many)).toEqual({
      accepted: false,
      reason: 'ambiguous_context',
      choices: [context, other.context],
    });
    expect(
      await planStoredReference({ ...request, context: other.context }, worker, many)
    ).toMatchObject({ accepted: true, context: other.context });
    expect(await planStoredReference(request, { ...worker, sessionId: 'revoked' }, deps)).toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    expect(
      await planStoredReference(request, human, {
        ...deps,
        loadSource: async () => ({ ...source, bindings: [{ ...binding, daemonId: 'remote' }] }),
      })
    ).toEqual({ accepted: false, reason: 'owning_daemon_unavailable' });
  });
  test('binds PR and commit URL plans to a known repository and exact stored target', async () => {
    for (const url of [
      `https://github.com/lsm/HyperNeo/blob/${sha}/docs/report.md`,
      'https://github.com/lsm/HyperNeo/pull/7990',
    ]) {
      const run = (repository: string | null) =>
        planStoredReference({ ...request, reference: url }, human, {
          ...deps,
          loadSource: async () => ({
            ...source,
            text: `[Open](${url})`,
            bindings: [{ ...binding, repository }],
          }),
        });
      expect(await run(binding.repository)).toMatchObject({
        accepted: true,
        repository: binding.repository,
      });
      expect(await run('github.com/lsm/other')).toEqual({ accepted: false, reason: 'unavailable' });
    }
  });
  test('plans an explicitly referenced file outside the workspace', async () => {
    const reference = '/outside/report.md';
    expect(
      await planStoredReference({ ...request, reference }, human, {
        ...deps,
        loadSource: async () => ({ ...source, text: `[Open](${reference})` }),
      })
    ).toMatchObject({
      accepted: true,
      kind: 'worktree',
      root: '/outside',
      relativePath: 'report.md',
    });
  });
  test('applies existing defense-in-depth policy without granting any byte read', async () => {
    for (const [reference, reason] of [
      ['../outside.md', 'unsafe_path'],
      ['.ssh/key.md', 'sensitive_path'],
    ]) {
      expect(
        await planStoredReference({ ...request, reference }, human, {
          ...deps,
          loadSource: async () => ({ ...source, text: `[Open](${reference})` }),
        })
      ).toMatchObject({ accepted: false, reason });
    }
  });
});
