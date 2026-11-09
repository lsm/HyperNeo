import { describe, expect, test } from 'bun:test';
import { resolveNeoTodoDraft } from '../../../../src/lib/neo/todo-operations.ts';
import { createCodingTodoPolicy } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

const policy = createCodingTodoPolicy({ urls: () => [] });
const draft = {
  title: 'Synthetic coding work',
  check: { pack: 'coding', kind: 'pr_merged', params: {} },
  instruction: 'Implement the change',
  named: { repository: 'example/repo' },
  target: { verb: 'send' as const, ref: { adapter: 'hyperneo' as const, id: 'worker' } },
};

describe('coding worker repository admission', () => {
  test.each([
    'https://github.com/EXAMPLE/REPO.git',
    'git@github.com:example/repo.git',
    'ssh://git@github.com/example/repo.git',
  ])('accepts the same repository through %s', (remote) => {
    expect(policy.refuse(draft, [], { ask: null, workerRemotes: [remote] })).toBeNull();
  });
  test.each([
    { remotes: ['https://github.com/example/other.git'], worker: 'github.com/example/other' },
    { remotes: [], worker: 'unknown' },
    { remotes: undefined, worker: 'unknown' },
  ])('refuses mismatched or unknown remotes: $worker', ({ remotes, worker }) => {
    expect(policy.refuse(draft, [], { ask: null, workerRemotes: remotes })).toBe(
      `worker_repository_mismatch: todo is github.com/example/repo, worker worker is in ${worker}; send it to a worker of github.com/example/repo or start one there.`
    );
  });
  test('accepts non-coding work and coding work without a known repository', () => {
    expect(
      policy.refuse({ ...draft, check: { pack: 'core', kind: 'evidence', params: {} } }, [], {
        ask: null,
      })
    ).toBeNull();
    expect(policy.refuse({ ...draft, named: null }, [], { ask: null })).toBeNull();
  });
});

describe('remote todo worker repository resolution', () => {
  test.each([{ remotes: undefined }, { remotes: ['git@github.com:example/repo.git'] }])(
    'uses only reported remotes for a remote worker',
    async ({ remotes }) => {
      const ref = { ...draft.target.ref, daemon: 'remote-owner' };
      const resolved = await resolveNeoTodoDraft(
        { ...draft, target: { verb: 'send', ref }, start: false, priority: 'normal' },
        async () => ({
          value: ref,
          place: { folder: '/not-a-local-worker', remotes: remotes ? [...remotes] : undefined },
        })
      );
      expect('reason' in resolved).toBe(false);
      if ('reason' in resolved) throw new Error('Unexpected resolution failure');
      expect(resolved.value.workerRemotes).toEqual(remotes);
      const reason = policy.refuse(resolved.value, [], {
        ask: null,
        workerRemotes: resolved.value.workerRemotes,
      });
      if (remotes) expect(reason).toBeNull();
      else expect(reason).toContain('is in unknown;');
    }
  );
});

test.each([
  { remotes: ['git@github.com:example/repo.git'], mismatch: false },
  { remotes: ['https://github.com/example/other.git'], mismatch: true },
  { remotes: [], mismatch: true },
])(
  'checks an edited coding check when the stored repository is missing',
  ({ remotes, mismatch }) => {
    const edited = {
      ...draft,
      named: null,
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/example/repo/pull/1'] },
      },
    };
    const reason = policy.refuse(edited, [], {
      ask: null,
      todo: { repo: null },
      workerRemotes: remotes,
    });
    if (mismatch)
      expect(reason).toContain('worker_repository_mismatch: todo is github.com/example/repo');
    else expect(reason).toBeNull();
  }
);
