import {
  CodingPrSweepRepository,
  sweepCodingPrs,
  type CodingSweepDeps,
} from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { createCodingDaemonMergeSweep } from '../../../../src/lib/neo/packs/coding/daemon-merge-sweep.ts';
import { createCodingHumanMergeOperation } from '../../../../src/lib/neo/packs/coding/human-merge-operation.ts';
import { Logger } from '../../../../src/lib/logger.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/types.ts';

let warnings: unknown[][], restoreWarnings: () => void;
const head = 'a'.repeat(40),
  url = 'https://github.com/synthetic/merge/pull/1';
let db: Database,
  ledger: CodingPrLedgerRepository,
  calls: string[][],
  notices: string[],
  fail: string;
let state: string,
  actualHead: string,
  labels: string[],
  files: string[],
  ci: string,
  reviewHead: string,
  unresolved: boolean,
  deliver: boolean,
  hideOutcome: boolean,
  mergeFailed: boolean;
const policy = (key: string, value: unknown) =>
  db
    .prepare(
      "INSERT OR REPLACE INTO neo_pack_preferences(pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES('coding','repo','synthetic/merge',?,?,'synthetic',1)"
    )
    .run(key, JSON.stringify(value));
const spawn: SpawnFn = (args) => {
  calls.push(args);
  let data: unknown;
  if (args[2] === 'merge') {
    expect(args.slice(-3)).toEqual(['--squash', '--match-head-commit', head]);
    if (!mergeFailed) state = 'MERGED';
  } else if (args[2] === 'edit') labels = args.includes('--add-label') ? ['human-merge'] : [];
  else if (args.includes('graphql'))
    data = {
      data: {
        repository: {
          pullRequest: {
            url,
            headRefOid: actualHead,
            reviewThreads: {
              nodes: unresolved ? [{ id: 't', isResolved: false, comments: { nodes: [] } }] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
  else if (args.some((a) => a.endsWith('/labels'))) data = [labels.map((name) => ({ name }))];
  else if (args.some((a) => a.endsWith('/reviews')))
    data = [
      [
        {
          state: 'APPROVED',
          commit_id: reviewHead,
          user: { login: 'bot', type: 'Bot' },
          html_url: url + '#review',
        },
      ],
    ];
  else if (args[2] === 'checks') data = [{ name: 'Required', bucket: ci, link: url + '/checks' }];
  else
    data = {
      url,
      body: '',
      state,
      headRefOid: actualHead,
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      author: { login: 'author' },
      changedFiles: files.length,
      files: files.map((path) => ({ path })),
      labels: [],
      mergeCommit: state === 'MERGED' ? { oid: 'c'.repeat(40) } : null,
    };
  const broken =
    (fail && args.some((a) => a.includes(fail))) ||
    (hideOutcome && state === 'MERGED') ||
    (mergeFailed && args[2] === 'merge');
  return {
    stdout: new Response(JSON.stringify(data ?? {})).body,
    stderr: new Response(mergeFailed && args[2] === 'merge' ? 'Required check still settling' : '')
      .body,
    exited: Promise.resolve(broken ? 1 : 0),
    exitCode: broken ? 1 : 0,
    kill() {},
  };
};
const sweep = (customSpawn: SpawnFn = spawn, overrides: Partial<CodingSweepDeps> = {}) =>
  createCodingDaemonMergeSweep(
    () => db,
    ledger,
    new CodingPrEventRepository(db),
    {
      tell: async () => {
        throw new Error('Unowned PR must route to Neo');
      },
      wake: async (_key, text) => {
        if (deliver) notices.push(text);
        return deliver;
      },
      ...overrides,
    },
    customSpawn
  );
const merges = () => calls.filter((args) => args[2] === 'merge');
const reserve = (at: number) =>
  ledger.write('daemonMerge', { kind: 'begin', url, head, actor: 'daemon:coding-sweep', at });
beforeEach(async () => {
  warnings = [];
  const warning = spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args);
  });
  restoreWarnings = () => warning.mockRestore();
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  ledger = new CodingPrLedgerRepository(db);
  calls = [];
  notices = [];
  fail = '';
  state = 'OPEN';
  actualHead = head;
  labels = [];
  files = ['src/app.ts'];
  ci = 'pass';
  reviewHead = head;
  unresolved = false;
  deliver = true;
  hideOutcome = false;
  mergeFailed = false;
  policy('mergeBy', 'daemon');
  policy('mergePolicy', 'review_bot');
  policy('reviewBot', 'bot');
  policy('humanSignoff', ['label:human-merge', 'docs/design/**']);
  await ledger.write(
    'replace',
    'synthetic/merge',
    [
      {
        repo: 'synthetic/merge',
        number: 1,
        title: 'Fixture',
        branch: 'fixture',
        head,
        state: 'approved_green',
        closedAt: null,
      },
    ],
    1
  );
});
afterEach(() => {
  restoreWarnings();
  db.close();
});
describe('daemon merge sweep behavior', () => {
  test('pins a single unowned merge and records executor/head/time across overlapping sweeps', async () => {
    const run = sweep();
    await Promise.all([run(10), run(11)]);
    await run(12);
    expect(merges()).toHaveLength(1);
    expect(notices).toEqual([expect.stringContaining(head)]);
    const rows = db.prepare('SELECT * FROM pack_coding_daemon_merges').all();
    expect(rows).toMatchObject([
      { head, actor: 'daemon:coding-sweep', merge_commit: 'c'.repeat(40) },
    ]);
  });
  test.each(['owner', 'human', 'path', 'ci', 'review', 'thread', 'head', 'closed', 'late'])(
    'holds %s',
    async (condition) => {
      if (condition === 'owner') policy('mergeBy', 'owner');
      if (condition === 'human') policy('mergePolicy', 'human');
      if (condition === 'path') files = ['docs/design/merge.md'];
      if (condition === 'ci') ci = 'pending';
      if (condition === 'review') reviewHead = 'b'.repeat(40);
      if (condition === 'thread') unresolved = true;
      if (condition === 'head') actualHead = 'b'.repeat(40);
      if (condition === 'closed') state = 'CLOSED';
      const delayed: SpawnFn = (args) => {
        if (
          condition === 'late' &&
          args[2] === 'view' &&
          calls.filter((a) => a[2] === 'view').length === 1
        )
          labels = ['human-merge'];
        return spawn(args);
      };
      await sweep(delayed)(10);
      expect(merges()).toHaveLength(0);
      if (['path', 'late'].includes(condition))
        expect(notices.some((text) => text.includes('sign-off'))).toBe(true);
      if (condition === 'late') {
        labels = [];
        await sweep(delayed)(11);
        expect(merges()).toHaveLength(1);
      }
    }
  );
  test.each(['/labels', '/reviews', 'checks', 'graphql', 'view', 'final'])(
    'does nothing when %s cannot be read',
    async (part) => {
      fail = part;
      const delayed: SpawnFn = (args) => {
        if (
          part === 'final' &&
          args[2] === 'view' &&
          calls.filter((a) => a[2] === 'view').length === 2
        )
          fail = 'view';
        return spawn(args);
      };
      await expect(sweep(delayed)(10)).resolves.toBeUndefined();
      expect(warnings).toContainEqual(['Daemon merge held', { url, reason: expect.any(String) }]);
      expect(merges()).toHaveLength(0);
      expect(notices).toEqual([]);
      expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
      if (part === 'final') {
        fail = '';
        await sweep()(11);
        expect(merges()).toHaveLength(1);
      }
    }
  );
  test('recovers an uncertain merged outcome without repeating the command and retries notice', async () => {
    hideOutcome = true;
    await expect(sweep()(10)).resolves.toBeUndefined();
    expect(warnings).toContainEqual(['Daemon merge held', { url, reason: expect.any(String) }]);
    expect(merges()).toHaveLength(1);
    expect(notices).toEqual([]);
    hideOutcome = false;
    deliver = false;
    await sweep()(11);
    expect(await ledger.write('daemonMerge', { kind: 'list' })).toMatchObject([
      { head, mergedAt: 11 },
    ]);
    deliver = true;
    await sweep()(12);
    expect(merges()).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
  });
  test.each(['same', 'moved'])(
    'warns without retrying a reserved attempt on %s head',
    async (which) => {
      await reserve(2);
      if (which === 'moved') actualHead = 'b'.repeat(40);
      await sweep()(10);
      await sweep()(11);
      expect(merges()).toHaveLength(0);
      expect(notices.some((text) => text.includes('held: ' + url + ' head ' + head))).toBe(true);
    }
  );
});
test('human merge operation adds and removes the label on explicit intent', async () => {
  const operation = createCodingHumanMergeOperation(spawn);
  const caller = { role: 'neo' } as Parameters<typeof operation.execute>[1];
  expect(await operation.execute({ url, enabled: true }, caller)).toEqual({ accepted: true });
  const before = calls.length;
  const denied = { ...caller, role: 'direct_task_worker' as const };
  const result = await operation.execute({ url, enabled: false }, denied);
  expect(result).toMatchObject({ accepted: false });
  expect(calls).toHaveLength(before);
  expect(labels).toEqual(['human-merge']);
  await sweep()(10);
  expect(merges()).toHaveLength(0);
  expect(await operation.execute({ url, enabled: false }, caller)).toEqual({ accepted: true });
  expect(labels).toEqual([]);
  fail = 'edit';
  const failedEdit = await operation.execute({ url, enabled: true }, caller);
  expect(failedEdit).toMatchObject({ accepted: false, reason: expect.stringContaining('GitHub') });
  expect(failedEdit).not.toMatchObject({ reason: expect.stringContaining('Only Neo') });
  fail = '';
  expect(
    await operation.execute({ url: 'https://attacker.example/pr/1', enabled: true }, caller)
  ).toMatchObject({ accepted: false });
});

test('daemon execution suppresses owner merge events and reminders', async () => {
  const owner = { adapter: 'hyperneo', id: 'fixture-owner' },
    row = (await ledger.read('list'))[0];
  db.prepare('UPDATE pack_coding_pr_ledger SET owner=?, terminal_event_json=?, read_at=?').run(
    JSON.stringify(owner),
    JSON.stringify({ ...row, from: 'waiting_review' }),
    20 * 60_000
  );
  const messages: string[] = [];
  const receive = async (...args: unknown[]) => {
    messages.push(String(args.at(-1)));
    return true;
  };
  const delivery = { tell: receive, wake: receive };
  await deliverCodingPrEvents(new CodingPrEventRepository(db), [], delivery);
  await sweepCodingPrs(new CodingPrSweepRepository(db), delivery, 20 * 60_000);
  expect(messages).toEqual([]);
  await sweep(spawn, delivery)(20 * 60_000);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('Merge confirmed:');
});

test.each(['batch', 'final', 'receipt'])(
  'an unreadable first PR at %s does not block a mergeable sibling',
  async (stage) => {
    let reads = 0;
    if (stage === 'receipt') await reserve(1);
    const rows = await ledger.read('list');
    await ledger.write('replace', 'synthetic/merge', [...rows, { ...rows[0], number: 2 }], 2);
    const partial: SpawnFn = (args) => {
      const result = spawn(args);
      if (args[2] === 'view' && args[3] === url && ++reads > (stage === 'final' ? 2 : 0))
        return { ...result, exited: Promise.resolve(1), exitCode: 1 };
      return {
        ...result,
        stdout: new ReadableStream({
          async start(controller) {
            const text = await new Response(result.stdout).text();
            controller.enqueue(
              new TextEncoder().encode(
                args.some(
                  (a) =>
                    a.includes('/pull/2') ||
                    a.includes('/pulls/2/') ||
                    a.includes('/issues/2/') ||
                    a === 'number=2'
                )
                  ? text.replaceAll(url, url.replace('/1', '/2'))
                  : text
              )
            );
            controller.close();
          },
        }),
      };
    };
    await sweep(partial)(10);
    expect(merges().map((args) => args[3])).toEqual([url.replace('/1', '/2')]);
    expect(notices).toEqual([expect.stringContaining(url.replace('/1', '/2'))]);
    expect(warnings).toContainEqual([
      'Daemon merge held',
      { url, reason: expect.stringContaining('pull:') },
    ]);
    await sweep(partial)(11);
    expect(merges()).toHaveLength(1);
    if (stage === 'receipt')
      expect(await ledger.write('daemonMerge', { kind: 'list' })).toMatchObject([
        { url, mergeCommit: null },
      ]);
  }
);

test('a receipt sharing a candidate cannot hide a failed read with a second response', async () => {
  await reserve(1);
  await ledger.write('daemonMerge', { kind: 'finish', url, head, commit: 'c'.repeat(40), at: 2 });
  state = 'MERGED';
  let failed = false;
  const flaky: SpawnFn = (args) => {
    if (!failed && args[2] === 'view') {
      failed = true;
      fail = 'view';
      const result = spawn(args);
      fail = '';
      return result;
    }
    return spawn(args);
  };
  const run = sweep(flaky);
  await expect(run(10)).resolves.toBeUndefined();
  expect(warnings).toContainEqual(['Daemon merge held', { url, reason: expect.any(String) }]);
  expect(failed).toBe(true);
  expect(notices).toEqual([]);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toHaveLength(1);
  expect(merges()).toHaveLength(0);
});

test.each([undefined, 'GHE.company.test'])(
  'routes host %s; in-flight writer revocation remains a known limitation (#9458)',
  async (configured) => {
    const previous = process.env.GH_HOST;
    const host = configured?.toLowerCase() ?? 'github.com';
    if (configured === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = configured;
    const hosted: SpawnFn = (args) => {
      if (args[2] === 'merge') policy('mergeBy', 'owner');
      const result = spawn(args);
      const enterprise = args.some((arg) => arg.includes('ghe.company.test'));
      return {
        ...result,
        stdout: new ReadableStream({
          async start(controller) {
            const text = await new Response(result.stdout).text();
            controller.enqueue(
              new TextEncoder().encode(enterprise ? text.replaceAll('github.com', host) : text)
            );
            controller.close();
          },
        }),
      };
    };
    try {
      const run = sweep(hosted, { tell: async () => false, wake: async () => true });
      await run(10);
      expect(merges()).toHaveLength(1);
      expect(merges()[0][3]).toBe(`https://${host}/synthetic/merge/pull/1`);
      expect(ledger.policy('synthetic/merge').mergeBy).toBe('owner');
      expect(
        calls
          .filter((args) => args[2] === 'view' || args[2] === 'checks')
          .every((args) => args[3].startsWith(`https://${host}/`))
      ).toBe(true);
      expect(
        calls
          .filter((args) => args.includes('--hostname'))
          .every((args) => args[args.indexOf('--hostname') + 1] === host)
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previous;
    }
  }
);

test.each(['human', undefined])(
  'surfaces daemon policy %s without chasing owners',
  async (value) => {
    if (value) policy('mergePolicy', value);
    else db.prepare("DELETE FROM neo_pack_preferences WHERE key='mergePolicy'").run();
    const run = sweep();
    await run(10);
    expect(notices).toHaveLength(1);
    const rows = await ledger.read('list');
    await ledger.write('replace', 'synthetic/merge', [{ ...rows[0], state: 'waiting_human' }], 11);
    await run(12);
    expect(notices).toHaveLength(2);
    expect(notices.every((text) => text.includes('sign-off'))).toBe(true);
    expect(merges()).toHaveLength(0);
  }
);

test('a rejected sign-off delivery holds merging but lets the sweep finish and retry', async () => {
  labels = ['human-merge'];
  let wakes = 0;
  const run = sweep(spawn, {
    tell: async () => false,
    wake: async () => {
      if (++wakes === 1) throw new Error('Synthetic mailbox unavailable');
      return true;
    },
  });
  await expect(run(10)).resolves.toBeUndefined();
  await run(11);
  expect(wakes).toBe(2);
  expect(merges()).toHaveLength(0);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
});

test('waiting_human rows are signaling-only even if fresh gates would allow merging', async () => {
  const rows = await ledger.read('list');
  await ledger.write('replace', 'synthetic/merge', [{ ...rows[0], state: 'waiting_human' }], 2);
  await sweep()(10);
  expect(merges()).toHaveLength(0);
});

test.each<[string, unknown]>([
  ['mergeBy', 'owner'],
  ['mergePolicy', 'human'],
  ['humanSignoff', ['src/**']],
])(
  'a human change to %s=%s during fresh GitHub reads revokes daemon admission',
  async (key, value) => {
    const racing: SpawnFn = (args) => {
      if (args[2] === 'checks') policy(key, value);
      return spawn(args);
    };
    await sweep(racing, { tell: async () => false, wake: async () => true })(10);
    expect(ledger.policy('synthetic/merge')[key as keyof ReturnType<typeof ledger.policy>]).toEqual(
      value
    );
    expect(merges()).toHaveLength(0);
  }
);

test('an unreadable final saved policy fails closed before launching the merge', async () => {
  const fault = spyOn(ledger, 'policy').mockImplementation(() => {
    throw new Error('Policy read unavailable');
  });
  try {
    await expect(sweep()(10)).rejects.toThrow('Policy read unavailable');
    expect(merges()).toHaveLength(0);
    expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
  } finally {
    fault.mockRestore();
  }
});

test('a failed open attempt surfaces a held receipt without retrying or misattributing an external merge', async () => {
  mergeFailed = true;
  deliver = false;
  db.prepare('UPDATE pack_coding_pr_ledger SET owner=?').run(
    JSON.stringify({ adapter: 'claude-desktop', id: 'synthetic-owner' })
  );
  const receive = async (...args: unknown[]) => {
    if (!deliver) return false;
    notices.push(String(args.at(-1)));
    return true;
  };
  const run = sweep(spawn, { tell: receive, wake: receive });
  await run(10);
  expect(merges()).toHaveLength(1);
  expect(notices).toEqual([]);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toHaveLength(1);
  deliver = true;
  await run(11);
  await run(12);
  expect(notices).toEqual([expect.stringContaining(`held: ${url} head ${head}`)]);
  state = 'MERGED';
  await run(13);
  expect(merges()).toHaveLength(1);
  expect(notices).toHaveLength(2);
  expect(notices[1]).toContain('Merge confirmed:');
  expect(notices[1]).not.toContain('merged by');
  expect(notices[1]).toContain('c'.repeat(40));
  expect(notices[1]).toContain('confirmation sweep');
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
});

test('terminal unconfirmed receipts retire durably after their held warning', async () => {
  await reserve(2);
  actualHead = 'b'.repeat(40);
  state = 'MERGED';
  await sweep()(10);
  expect(notices).toHaveLength(1);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
  fail = 'view';
  await ledger.write('replace', 'synthetic/merge', [], 11);
  await sweep()(12);
  expect(merges()).toHaveLength(0);
  expect(notices).toHaveLength(1);
});

test('a failed merge command is retried by the next sweep and confirms only once', async () => {
  mergeFailed = true;
  await sweep()(10);
  expect(merges()).toHaveLength(1);
  mergeFailed = false;
  const restarted = sweep();
  await restarted(11);
  await restarted(12);
  expect(merges()).toHaveLength(2);
  expect(notices.filter((text) => text.includes('Merge confirmed:'))).toHaveLength(1);
  expect(warnings).toContainEqual([
    'Daemon merge held',
    { url, reason: expect.stringContaining('Required check still settling') },
  ]);
});
