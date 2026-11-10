import { readCodingTodoWorker } from '../../../../src/lib/neo/packs/coding/worker-read.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNeoTodoTarget } from '../../../../src/lib/neo/todo-target.ts';
import { resolveNeoTodoDraft as resolveCoreTodoDraft } from '../../../../src/lib/neo/todo-operations.ts';
import { createCodingTodoPolicy } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

function resolveNeoTodoDraft(
  input: Parameters<typeof resolveCoreTodoDraft>[0],
  read: Parameters<typeof resolveCoreTodoDraft>[1]
) {
  return resolveCoreTodoDraft(input, (ref) => readCodingTodoWorker(ref, read));
}

let fixture: string;
let originalPath: string | undefined;
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'worker-remote-'));
  originalPath = process.env.PATH;
  process.env.PATH = `${fixture}:${originalPath ?? ''}`;
  writeFileSync(join(fixture, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
});
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(fixture, { recursive: true, force: true });
});

const policy = createCodingTodoPolicy({
  urls: () => [],
  place: (scope) => ({ ask: null, peers: [], ...('todo' in scope ? { todo: null } : {}) }),
});
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
      todo: { id: 'edited' },
      edit: true,
      workerRemotes: remotes,
    });
    if (mismatch)
      expect(reason).toContain('worker_repository_mismatch: todo is github.com/example/repo');
    else expect(reason).toBeNull();
  }
);

test.each([
  {
    name: 'matching remote',
    id: 'worker',
    daemon: 'remote-owner',
    remotes: ['git@github.com:example/repo.git'],
    accepted: true,
  },
  { name: 'unknown remotes', id: 'worker', daemon: 'remote-owner', remotes: [], accepted: false },
  {
    name: 'another worker',
    id: 'worker-prefix-neighbor',
    daemon: 'remote-owner',
    remotes: ['git@github.com:example/repo.git'],
    accepted: false,
  },
  {
    name: 'another daemon',
    id: 'worker',
    daemon: 'other-owner',
    remotes: ['git@github.com:example/repo.git'],
    accepted: false,
  },
])(
  'remote discovery uses the exact worker place: $name',
  async ({ id, daemon, remotes, accepted }) => {
    const ref = { ...draft.target.ref, daemon: 'remote-owner' };
    const calls: { name: string; input: unknown }[] = [];
    const place = {
      machine: 'synthetic',
      name: 'Remote repository',
      remotes,
    };
    const resolved = await resolveNeoTodoDraft(
      { ...draft, target: { verb: 'send', ref }, start: false, priority: 'normal' },
      (candidate) =>
        resolveNeoTodoTarget(candidate, async (name, input) => {
          calls.push({ name, input });
          return {
            kind: 'completed',
            value:
              name === 'work.status'
                ? {
                    ok: true,
                    value: { ref, place: { machine: 'synthetic', name: 'Remote repository' } },
                  }
                : {
                    places: [
                      {
                        place,
                        adapters: [ref.adapter],
                        lastActivityAt: 1,
                        openCount: 1,
                        archivedCount: 0,
                        work: [
                          {
                            ref: { ...ref, id, daemon },
                            place,
                            title: 'Remote worker',
                            status: 'running',
                            lastActivityAt: 1,
                          },
                        ],
                      },
                    ],
                    unreachable: [],
                  },
          };
        })
    );
    if ('reason' in resolved) throw new Error(resolved.reason.reason);
    expect(resolved.value.workerRemotes).toEqual(
      id === ref.id && daemon === ref.daemon ? remotes : undefined
    );
    expect(calls).toContainEqual({
      name: 'work.find',
      input: expect.objectContaining({ idPrefix: ref.id, adapters: [ref.adapter] }),
    });
    const reason = policy.refuse(resolved.value, [], {
      ask: null,
      workerRemotes: resolved.value.workerRemotes,
    });
    if (accepted) expect(reason).toBeNull();
    else expect(reason).toContain('worker_repository_mismatch:');
  }
);

test.each([
  { succeeds: true, repository: 'repo', accepted: true },
  { succeeds: false, repository: 'repo', accepted: false },
  { succeeds: true, repository: 'old-name', accepted: true },
])(
  'canonical worker remote $repository lookup succeeds=$succeeds',
  async ({ succeeds, repository, accepted }) => {
    writeFileSync(
      join(fixture, 'gh'),
      `#!/bin/sh
printf '%s\\n' "$@" > "$0.calls"
${succeeds ? 'printf \'%s\\n\' \'{"full_name":"example/repo"}\'' : 'exit 1'}
`,
      { mode: 0o700 }
    );
    const ref = { ...draft.target.ref, daemon: 'remote-owner' };
    const remote = 'git@github.com:example/old-name.git';
    const resolved = await resolveNeoTodoDraft(
      {
        ...draft,
        named: { repository: `example/${repository}` },
        target: { verb: 'send', ref },
        start: false,
        priority: 'normal',
      },
      async () => ({ value: ref, place: { remotes: [remote] } })
    );
    if ('reason' in resolved) throw new Error(resolved.reason.reason);
    const refusal = policy.refuse(resolved.value, [], {
      ask: null,
      workerRemotes: resolved.value.workerRemotes,
    });
    if (accepted) expect(refusal).toBeNull();
    else {
      expect(resolved.value.workerRemotes).toEqual([remote]);
      expect(refusal).toContain('worker_repository_mismatch:');
    }
    expect(readFileSync(join(fixture, 'gh.calls'), 'utf8').trim().split('\n')).toEqual([
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      '--cache',
      '24h',
      'repos/example/old-name',
      '--include',
    ]);
  }
);
