import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { CodingAssignmentsRepository } from '../../../../src/lib/neo/packs/coding/assignments.ts';
import { CodingStageFactsRepository } from '../../../../src/lib/neo/packs/coding/stage-facts.ts';
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
import { CODING_ATTENTION_KINDS } from '../../../../src/lib/neo/packs/coding/attention.ts';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { neoAttentionNotes } from '../../helpers/neo-attention-notes.ts';
import { createCodingHumanMergeOperation } from '../../../../src/lib/neo/packs/coding/human-merge-operation.ts';
import { Logger } from '../../../../src/lib/logger.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/types.ts';
import { NeoTrackerMirrorRepository } from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

let warnings: unknown[][], restoreWarnings: () => void;
const head = 'a'.repeat(40),
  url = 'https://github.com/synthetic/merge/pull/1';
let db: Database,
  ledger: CodingPrLedgerRepository,
  calls: string[][],
  notices: string[],
  fail: string;
let mergeStateStatus: string;
let mergeable: string;
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
    expect(args.slice(-3)).toEqual(['--squash', '--match-head-commit', actualHead]);
    if (!mergeFailed) state = 'MERGED';
  } else if (args[2] === 'edit') labels = args.includes('--add-label') ? ['human-merge'] : [];
  else if (args.some((arg) => arg.includes('CodingMergeFiles'))) {
    const pages = files.length > 100 ? [files.slice(0, 100), files.slice(100)] : [files];
    data = pages.map((paths, i) => ({
      data: {
        repository: {
          pullRequest: {
            headRefOid: actualHead,
            baseRefOid: 'd'.repeat(40),
            files: {
              nodes: paths.map((path) => ({ path })),
              pageInfo: { hasNextPage: i < pages.length - 1, endCursor: String(i) },
            },
          },
        },
      },
    }));
  } else if (args.includes('graphql'))
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
      baseRefOid: 'd'.repeat(40),
      isDraft: false,
      mergeable,
      mergeStateStatus,
      author: { login: 'author' },
      changedFiles: files.length,
      files: files.slice(0, 100).map((path) => ({ path })),
      labels: [],
      mergeCommit: state === 'MERGED' ? { oid: 'c'.repeat(40) } : null,
    };
  const candidateUrl = args.some(
    (arg) => arg === url.replace('/1', '/2') || arg.includes('/pulls/2/') || arg === 'number=2'
  )
    ? url.replace('/1', '/2')
    : url;
  const broken =
    (fail && args.some((a) => a.includes(fail))) ||
    (hideOutcome && state === 'MERGED' && args[2] !== 'merge') ||
    (mergeFailed && args[2] === 'merge');
  return {
    stdout: new Response(JSON.stringify(data ?? {}).replaceAll(url, candidateUrl)).body,
    stderr: new Response(mergeFailed && args[2] === 'merge' ? 'Required check still settling' : '')
      .body,
    exited: Promise.resolve(broken ? 1 : 0),
    exitCode: broken ? 1 : 0,
    kill() {},
  };
};
type Attend = (event: NeoAttentionEvent) => Promise<boolean>;
const sweep = (
  customSpawn: SpawnFn = spawn,
  overrides: Partial<CodingSweepDeps & { attend: Attend }> = {}
) => {
  const wake: CodingSweepDeps['wake'] =
    overrides.wake ??
    (async (_key, text) => {
      if (deliver) notices.push(text);
      return deliver;
    });
  return createCodingDaemonMergeSweep(
    () => db,
    ledger,
    new CodingPrEventRepository(db),
    {
      tell: async () => {
        throw new Error('Unowned PR must route to Neo');
      },
      attend: (event) =>
        wake(`${event.kind}:${event.subject.id}:${event.since}`, String(event.facts.text)),
      ...overrides,
    },
    customSpawn
  );
};
const entry = () => {
  const notes = neoAttentionNotes(
    db,
    new NeoAskTodoRepository(db),
    () => {},
    CODING_ATTENTION_KINDS
  );
  const run = (now: number) =>
    sweep(spawn, { attend: async (event) => 'told' in (await notes.tell(event, now)) })(now);
  return { run, wakes: notes.wakes };
};
const merges = () => calls.filter((args) => args[2] === 'merge');
const completeRead = async (at: number) => {
  await ledger.write('recordHealth', 'synthetic/merge', { at, outcome: 'complete' });
  await ledger.write('replace', 'synthetic/merge', await ledger.read('list'), at);
};
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
  mergeStateStatus = 'CLEAN';
  mergeable = 'MERGEABLE';
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
  test.each([
    'covered',
    'no-assignment',
    'old-head',
    'finished-review',
    'human-question',
    'closed-todo',
    'file-signoff',
    'human-policy',
    'bot-assignment',
  ])('a human-merge hold preserves the actionable counterpart: %s', async (scenario) => {
    labels = ['human-merge'];
    const store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'review-ask',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: 'Review',
      request: 'Review this work',
      createdAt: 1,
    });
    const todo = store.addTodo(
      'review-todo',
      'review-ask',
      {
        title: 'Change',
        instruction: 'Build',
        doneWhen: 'Merged',
        named: null,
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
      },
      2
    );
    store.updateTodo(todo, { state: scenario === 'closed-todo' ? 'done' : 'doing' }, 3);
    const assignedHead = scenario === 'old-head' ? 'b'.repeat(40) : head;
    const stages = new CodingStageFactsRepository(db);
    stages.observeHead(url, assignedHead, 4);
    const actor = {
      kind: 'agent' as const,
      id: 'reviewer',
      harness: 'hyperneo',
      model: 'review-model',
    };
    const ref = { adapter: 'hyperneo', id: 'reviewer' };
    if (scenario !== 'no-assignment')
      expect(
        new CodingAssignmentsRepository(db).record(todo.id, 'review', {
          url,
          head: assignedHead,
          acceptanceContract: 'contract',
          newDispatch: true,
          write: { adapter: 'hyperneo', id: 'writer' },
          ...(scenario === 'bot-assignment' ? { bot: 'bot' } : { actor, ref }),
        })
      ).toBe(true);
    if (!['no-assignment', 'bot-assignment'].includes(scenario))
      db.prepare("INSERT INTO pack_facts(todo_id,pack,key,value_json) VALUES(?,'coding',?,?)").run(
        todo.id,
        `review-handoff:${url}:${assignedHead}`,
        JSON.stringify({
          state: scenario === 'finished-review' ? 'returned' : 'pending',
          ref,
          receipt: { executionId: ref.id, inputId: 'review' },
        })
      );
    if (scenario === 'finished-review')
      stages.record({
        url,
        head,
        stage: 'review',
        actor,
        ref,
        verdict: 'pass',
        acceptanceContract: 'contract',
        evidence: ['Reviewed'],
      });
    if (scenario === 'human-question')
      store.askQuestion(
        'decision',
        'review-ask',
        {
          todoId: todo.id,
          kind: 'reply',
          text: 'Choose the next step',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
        },
        5
      );
    if (scenario === 'file-signoff') files = ['docs/design/change.md'];
    if (scenario === 'human-policy') policy('mergePolicy', 'human');
    const run = sweep();
    await run(10);
    expect(merges()).toEqual([]);
    expect(notices).toHaveLength(scenario === 'covered' ? 0 : 1);
    if (scenario === 'covered') {
      await run(11);
      expect(notices).toHaveLength(0);
      store.askQuestion(
        'later-decision',
        'review-ask',
        {
          todoId: todo.id,
          kind: 'reply',
          text: 'Choose the next step',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
        },
        12
      );
      await run(13);
      expect(notices).toHaveLength(1);
      expect(merges()).toEqual([]);
    }
  });

  test('an unavailable review lookup preserves this hold notice and the next candidate', async () => {
    labels = ['human-merge'];
    const second = 'https://github.com/synthetic/merge/pull/2';
    await ledger.write(
      'replace',
      'synthetic/merge',
      [...ledger.list(), { ...ledger.list()[0], number: 2 }],
      2
    );
    const lookup = spyOn(CodingAssignmentsRepository.prototype, 'reviewHoldsCurrent')
      .mockResolvedValue([])
      .mockRejectedValueOnce(new Error('Read queue full'));
    try {
      await expect(sweep()(10)).resolves.toBeUndefined();
      expect(notices).toEqual([
        expect.stringContaining(url + ' requires human sign-off'),
        expect.stringContaining(second + ' requires human sign-off'),
      ]);
      expect(merges()).toEqual([]);
    } finally {
      lookup.mockRestore();
    }
  });

  test('accepting a stopped budget preserves failures and still caps the next budget', async () => {
    for (let episode = 0; episode < 2; episode++) {
      for (let i = 0; i < 3; i++) {
        const [receipt] = await reserve(episode * 10 + i);
        expect(receipt).toBeDefined();
        await ledger.write('daemonMerge', {
          ...receipt,
          kind: 'failed',
          error: 'Refused',
          at: receipt.startedAt,
        });
        await ledger.write('daemonMerge', { ...receipt, kind: 'void', at: receipt.startedAt });
      }
      expect(await reserve(episode * 10 + 3)).toEqual([]);
      if (episode === 0) {
        await ledger.write('daemonMerge', { kind: 'retry', url, head, at: 0 });
        expect(await ledger.write('daemonMerge', { kind: 'failures', url, head })).toEqual([]);
        await ledger.write('daemonMerge', { kind: 'retry', url, head, at: 1000 });
      }
    }
    expect((await ledger.write('daemonMerge', { kind: 'failures', url, head }))[0].failures).toBe(
      3
    );
    expect(db.prepare('SELECT count(*) AS n FROM pack_coding_daemon_merge_failures').get()).toEqual(
      { n: 6 }
    );
  });
  test.each([false, true])(
    'complete 171-file scope holds only for a protected tail path=%s',
    async (protectedTail) => {
      db.prepare("UPDATE pack_coding_pr_ledger SET state='waiting_human'").run();
      files = Array.from({ length: 171 }, (_, i) => `src/file-${i}.ts`);
      if (protectedTail) files[170] = 'docs/design/requires-signoff.md';
      const run = sweep();
      await run(10);
      await run(11);
      expect(merges()).toEqual(
        protectedTail ? [] : [['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]]
      );
      expect(calls.some((args) => args.some((arg) => arg.includes('CodingMergeFiles')))).toBe(true);
    }
  );
  test.each(['UNSTABLE', 'BLOCKED', 'UNKNOWN'])(
    'a completed scope cannot bypass unsettled commit status %s',
    async (status) => {
      db.prepare("UPDATE pack_coding_pr_ledger SET state='waiting_human'").run();
      files = Array.from({ length: 171 }, (_, i) => `src/file-${i}.ts`);
      mergeStateStatus = status;
      await sweep()(10);
      expect(merges()).toHaveLength(0);
    }
  );
  test('turning issue mirroring off releases a cached linked-issue hold without a GitHub read', async () => {
    const store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      sessionId: 'synthetic',
      projectId: null,
      originMessageId: null,
      title: 'Plan',
      request: 'Work',
      createdAt: 1,
    });
    store.addTodo(
      'todo',
      'ask',
      {
        title: 'Step',
        instruction: 'Work',
        named: null,
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
      },
      2,
      'synthetic/merge'
    );
    policy('mirror_issues', true);
    const mirrors = new NeoTrackerMirrorRepository(db);
    for (const ownerKind of ['ask', 'todo'] as const)
      mirrors.put({
        ownerKind,
        ownerId: ownerKind,
        tracker: 'github-issues',
        home: 'synthetic/merge',
        ref: `synthetic/merge#${ownerKind === 'ask' ? 20 : 21}`,
        parentRef: null,
        state: 'bound',
        failures: 0,
        updatedAt: 3,
      });
    const run = sweep();
    await run(10);
    expect(merges()).toEqual([]);
    policy('mirror_issues', false);
    await run(11);
    expect(merges()).toEqual([['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]]);
  });
  test('a sign-off hold told on a cached read still refreshes ten minutes after that read', async () => {
    labels = ['human-merge'];
    deliver = false;
    const run = sweep();
    await run(10);
    deliver = true;
    await run(300_000);
    const reads = calls.length;
    await run(600_011);
    expect(calls.length).toBeGreaterThan(reads);
  });
  test('a final read that finds an unresolved thread is what the next unchanged pass uses', async () => {
    let threadReads = 0;
    const racing: SpawnFn = (args, options) => {
      const isThreads =
        args.includes('graphql') && !args.some((arg) => arg.includes('CodingMergeFiles'));
      if (isThreads && threadReads++ === 1) unresolved = true;
      return spawn(args, options);
    };
    const run = sweep(racing);
    await run(10);
    expect(threadReads).toBe(2);
    expect(merges()).toEqual([]);
    const afterFirst = calls.length;
    await run(11);
    expect(calls.slice(afterFirst)).toEqual([]);
  });
  test('a PR that leaves the daemon candidates is read again when it returns', async () => {
    reviewHead = 'b'.repeat(40);
    const run = sweep();
    await run(10);
    policy('mergeBy', 'owner');
    await run(11);
    policy('mergeBy', 'daemon');
    const before = calls.length;
    await run(12);
    expect(calls.length).toBeGreaterThan(before);
  });
  test('an UNKNOWN mergeable read is not reused once GitHub settles it', async () => {
    mergeable = 'UNKNOWN';
    const run = sweep();
    await run(10);
    expect(merges()).toEqual([]);
    mergeable = 'MERGEABLE';
    await run(11);
    expect(merges()).toEqual([['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]]);
  });
  test('a cached PR whose local lookup fails holds only itself', async () => {
    reviewHead = 'b'.repeat(40);
    const rows = await ledger.read('list');
    await ledger.write('replace', 'synthetic/merge', [...rows, { ...rows[0], number: 2 }], 2);
    const second = url.replace('/1', '/2');
    const run = sweep();
    await run(10);
    expect(merges()).toEqual([]);
    const original = CodingTodoPrRepository.prototype.linkedIssues;
    let failFirst = true;
    const lookup = spyOn(CodingTodoPrRepository.prototype, 'linkedIssues').mockImplementation(
      function (this: CodingTodoPrRepository, prUrl: string, todoId?: string) {
        if (failFirst && prUrl.toLowerCase() === url) throw new Error('Read queue full');
        return original.call(this, prUrl, todoId);
      }
    );
    try {
      reviewHead = head;
      db.prepare(
        "UPDATE pack_coding_pr_ledger SET updated_at = '2026-11-16T12:00:00Z' WHERE number = 2"
      ).run();
      await expect(run(11)).resolves.toBeUndefined();
      expect(merges()).toEqual([
        ['gh', 'pr', 'merge', second, '--squash', '--match-head-commit', head],
      ]);
      failFirst = false;
      state = 'OPEN';
      db.prepare(
        "UPDATE pack_coding_pr_ledger SET updated_at = '2026-11-16T12:00:00Z' WHERE number = 1"
      ).run();
      await run(12);
      expect(merges()).toEqual([
        ['gh', 'pr', 'merge', second, '--squash', '--match-head-commit', head],
        ['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head],
      ]);
    } finally {
      lookup.mockRestore();
    }
  });
  test('a read with an incomplete file list is not reused', async () => {
    let fileReads = 0;
    const flaky: SpawnFn = (args, options) => {
      if (!args.some((arg) => arg.includes('CodingMergeFiles')) || fileReads++ > 0)
        return spawn(args, options);
      const saved = files;
      files = [];
      try {
        return spawn(args, options);
      } finally {
        files = saved;
      }
    };
    const run = sweep(flaky);
    await run(10);
    expect(merges()).toEqual([]);
    await run(11);
    expect(merges()).toEqual([['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]]);
  });
  test('two passes over an unchanged held PR read its merge facts from GitHub once', async () => {
    reviewHead = 'b'.repeat(40);
    const run = sweep();
    await run(10);
    const firstPass = calls.length;
    await run(11);
    expect(firstPass).toBeGreaterThan(0);
    expect(merges()).toEqual([]);
    expect(calls.slice(firstPass)).toEqual([]);
  });
  test('a PR updated on GitHub is read again and merges', async () => {
    reviewHead = 'b'.repeat(40);
    const run = sweep();
    await run(10);
    reviewHead = head;
    await run(11);
    expect(merges()).toEqual([]);
    db.prepare("UPDATE pack_coding_pr_ledger SET updated_at = '2026-11-16T12:00:00Z'").run();
    await run(12);
    expect(merges()).toEqual([['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]]);
  });
  test.each(['ci', 'review', 'thread', 'read'])(
    'a truncated-scope ledger never bypasses fresh %s gates',
    async (condition) => {
      db.prepare("UPDATE pack_coding_pr_ledger SET state='waiting_human'").run();
      files = Array.from({ length: 171 }, (_, i) => `src/file-${i}.ts`);
      if (condition === 'ci') ci = 'pending';
      if (condition === 'review') reviewHead = 'b'.repeat(40);
      if (condition === 'thread') unresolved = true;
      if (condition === 'read') fail = 'CodingMergeFiles';
      await sweep()(10);
      expect(merges()).toHaveLength(0);
    }
  );
  test.each([
    [false, 'no required checks'],
    [true, 'no required checks'],
    [false, 'no checks'],
    [true, 'no checks'],
  ] as const)(
    'daemon merges a zero-required-checks PR once with owner=%s and %s',
    async (owned, diagnostic) => {
      if (owned)
        db.prepare('UPDATE pack_coding_pr_ledger SET owner=?').run(
          JSON.stringify({ adapter: 'hyperneo', id: 'fixture-owner' })
        );
      const noRequired: SpawnFn = (args, options) => {
        if (args[2] !== 'checks') return spawn(args, options);
        calls.push(args);
        return {
          stdout: new Response('').body,
          stderr: new Response(`${diagnostic} reported on the 'fixture' branch\n`).body,
          exited: Promise.resolve(1),
          exitCode: 1,
          kill() {},
        };
      };
      const prs: (string | undefined)[] = [];
      const run = sweep(noRequired, {
        tell: async (_owner, _key, text, pr) => {
          notices.push(text);
          prs.push(pr);
          return true;
        },
      });
      await run(10);
      await run(11);
      expect(merges()).toEqual([
        ['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head],
      ]);
      expect(notices).toEqual([expect.stringContaining('Merge confirmed:')]);
      expect(prs).toEqual(owned ? [url] : []);
      expect(
        db.prepare('SELECT head,actor,merge_commit FROM pack_coding_daemon_merges').all()
      ).toEqual([{ head, actor: 'daemon:coding-sweep', merge_commit: 'c'.repeat(40) }]);
    }
  );
  test('a bot-approved ledger row awaiting CI reaches fresh zero-required-check gates', async () => {
    db.prepare("UPDATE pack_coding_pr_ledger SET state='approved_pending'").run();
    const noRequired: SpawnFn = (args, options) => {
      if (args[2] !== 'checks') return spawn(args, options);
      calls.push(args);
      return {
        stdout: new Response('[]').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill() {},
      };
    };
    const run = sweep(noRequired);
    await run(10);
    await run(11);
    expect(merges()).toEqual([['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head]]);
    expect(notices).toEqual([expect.stringContaining('Merge confirmed:')]);
  });
  test.each([
    'pending',
    'read-failure',
    'old-review',
    'nonempty-green',
    'human-signoff',
    'unresolved-thread',
  ])('pending ledger admission still refuses %s from fresh facts', async (reason) => {
    db.prepare("UPDATE pack_coding_pr_ledger SET state='approved_pending'").run();
    if (reason === 'pending') ci = 'pending';
    if (reason === 'read-failure') fail = 'checks';
    if (reason === 'old-review') reviewHead = 'b'.repeat(40);
    if (reason === 'human-signoff') labels = ['human-merge'];
    if (reason === 'unresolved-thread') unresolved = true;
    const fresh: SpawnFn = (args, options) => {
      if (args[2] !== 'checks' || ['pending', 'read-failure', 'nonempty-green'].includes(reason))
        return spawn(args, options);
      calls.push(args);
      return {
        stdout: new Response('[]').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill() {},
      };
    };
    await sweep(fresh)(10);
    expect(calls.some((args) => args[2] === 'checks')).toBe(true);
    expect(merges()).toEqual([]);
  });
  test('CI-only waiting rows reach human handoff and explicit opt-in, with fresh gates', async () => {
    policy('mergePolicy', 'ci_only');
    db.prepare("UPDATE pack_coding_pr_ledger SET state='waiting_ci'").run();
    const noRequired: SpawnFn = (args, options) => {
      if (args[2] !== 'checks') return spawn(args, options);
      calls.push(args);
      return {
        stdout: new Response('[]').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill() {},
      };
    };
    const human: string[] = [];
    const run = sweep(noRequired, {
      human: async (_key, text) => {
        human.push(text);
        return true;
      },
    });
    await run(10);
    expect(merges()).toEqual([]);
    expect(human).toEqual([expect.stringContaining('manual merge')]);
    expect(ledger.stateOf(url)).toBe('waiting_human');
    policy('allowNoChecksMerge', true);
    db.prepare("UPDATE pack_coding_pr_ledger SET state='waiting_ci'").run();
    await run(11);
    expect(merges()).toHaveLength(1);
  });
  test('owner execution evaluates handoff without entering daemon merge attempts or warnings', async () => {
    policy('mergeBy', 'owner');
    policy('mergePolicy', 'ci_only');
    const run = sweep();
    await run(10);
    await run(11);
    expect(calls.some((args) => args[2] === 'checks')).toBe(true);
    expect(merges()).toEqual([]);
    expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
    expect(warnings.some((args) => JSON.stringify(args).includes('merge_by_owner'))).toBe(false);
    expect(calls).toEqual([
      ['gh', 'pr', 'checks', url, '--required', '--json', 'bucket,name,link'],
      ['gh', 'pr', 'checks', url, '--required', '--json', 'bucket,name,link'],
    ]);
  });
  test('owner execution with zero-check opt-in needs neither handoff nor merge facts', async () => {
    policy('mergeBy', 'owner');
    policy('mergePolicy', 'ci_only');
    policy('allowNoChecksMerge', true);
    await sweep()(10);
    expect(calls).toEqual([]);
    expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
  });
  test.each(['unreadable', 'malformed'])(
    'owner handoff holds on a %s required-check probe without reading merge facts',
    async (reason) => {
      policy('mergeBy', 'owner');
      policy('mergePolicy', 'ci_only');
      const human: string[] = [];
      const probe: SpawnFn = (args, options) => {
        if (reason === 'unreadable') {
          fail = 'checks';
          return spawn(args, options);
        }
        calls.push(args);
        return {
          stdout: new Response('{}').body,
          stderr: new Response('').body,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill() {},
        };
      };
      await sweep(probe, { human: async (_key, text) => !!human.push(text) })(10);
      expect(calls).toEqual([
        ['gh', 'pr', 'checks', url, '--required', '--json', 'bucket,name,link'],
      ]);
      expect(human).toEqual([]);
      expect(warnings.some((args) => args[0] === 'Human merge handoff held')).toBe(true);
      expect(warnings.some((args) => args[0] === 'Daemon merge held')).toBe(false);
    }
  );
  test.each(['failed', 'cooldown', 'low-quota', 'core-empty', 'core-positive'])(
    'owner probes respect reconcile health: %s',
    async (reason) => {
      policy('mergeBy', 'owner');
      policy('mergePolicy', 'ci_only');
      await ledger.write('recordHealth', 'synthetic/merge', {
        at: 2,
        outcome: reason === 'failed' ? 'failed' : reason === 'cooldown' ? 'cooldown' : 'complete',
        ...(reason === 'cooldown' ? { retryAt: 1000 } : {}),
        ...(['low-quota', 'core-empty', 'core-positive'].includes(reason)
          ? {
              quota: {
                status: 200,
                resource: reason === 'low-quota' ? 'graphql' : 'core',
                remaining: reason === 'core-empty' ? 0 : 100,
                resetAt: 1000,
                requestId: null,
                retryAfterMs: null,
              },
            }
          : {}),
      });
      await sweep()(10);
      expect(calls).toEqual(
        reason === 'core-positive'
          ? [['gh', 'pr', 'checks', url, '--required', '--json', 'bucket,name,link']]
          : []
      );
    }
  );
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
  test.each([
    'owner',
    'human',
    'path',
    'ci',
    'failed-ci',
    'review',
    'thread',
    'head',
    'closed',
    'late',
  ])('holds %s', async (condition) => {
    if (condition === 'owner') policy('mergeBy', 'owner');
    if (condition === 'human') policy('mergePolicy', 'human');
    if (condition === 'path') files = ['docs/design/merge.md'];
    if (condition === 'ci') ci = 'pending';
    if (condition === 'failed-ci') ci = 'fail';
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
  });
  test.each(['/labels', '/reviews', 'CodingMergeFiles', 'checks', 'graphql', 'view', 'final'])(
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
  test.each(['same', 'moved'])('recovers a reserved OPEN attempt on %s head', async (which) => {
    await reserve(2);
    if (which === 'moved') actualHead = 'b'.repeat(40);
    await sweep()(10);
    await sweep()(11);
    expect(merges()).toHaveLength(which === 'same' ? 1 : 0);
    expect(warnings.some((args) => JSON.stringify(args).includes('previous attempt'))).toBe(true);
  });
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
    messages.push(args.map(String).join('\n'));
    return true;
  };
  const delivery = { host: 'github.com', tell: receive, wake: receive };
  await deliverCodingPrEvents(new CodingPrEventRepository(db), [], delivery);
  await sweepCodingPrs(
    new CodingPrSweepRepository(db),
    { ...delivery, attend: receive },
    20 * 60_000
  );
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

test('label invalidation during a facts read cannot be overwritten by that sweep', async () => {
  labels = ['human-merge'];
  let invalidated = false;
  const racing: SpawnFn = (args, options) => {
    const result = spawn(args, options);
    if (!invalidated && args.some((arg) => arg.includes('/labels'))) {
      invalidated = true;
      labels = [];
      run.invalidate(url);
    }
    return result;
  };
  const run = sweep(racing);
  await run(10);
  expect(invalidated).toBe(true);
  expect(merges()).toHaveLength(0);
  await run(11);
  expect(merges()).toHaveLength(1);
});

test('same-head sign-off holds skip reads for ten minutes then refresh every gate', async () => {
  labels = ['human-merge'];
  const run = sweep();
  await run(10);
  const firstReads = calls.length;
  expect(firstReads).toBeGreaterThan(0);
  labels = [];
  reviewHead = 'b'.repeat(40);
  await run(600_009);
  expect(calls).toHaveLength(firstReads);
  expect(merges()).toHaveLength(0);
  await run(600_010);
  expect(calls.length).toBeGreaterThan(firstReads);
  expect(merges()).toHaveLength(0);
  reviewHead = head;
  db.prepare("UPDATE pack_coding_pr_ledger SET updated_at = '2026-11-16T12:00:00Z'").run();
  await run(600_011);
  expect(merges()).toHaveLength(1);
});

test('a new head immediately refreshes a cached human sign-off hold', async () => {
  labels = ['human-merge'];
  const run = sweep();
  await run(10);
  const firstReads = calls.length;
  await run(11);
  expect(calls).toHaveLength(firstReads);
  actualHead = reviewHead = 'b'.repeat(40);
  labels = [];
  const rows = await ledger.read('list');
  await ledger.write('replace', 'synthetic/merge', [{ ...rows[0], head: actualHead }], 12);
  await run(12);
  expect(calls.length).toBeGreaterThan(firstReads);
  expect(merges()).toHaveLength(1);
});

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

test('three failed attempts stop durably and tell Neo the error even after rejected delivery', async () => {
  mergeFailed = true;
  deliver = false;
  const accepted = new Set<string>();
  const receive = async (key: string, text: string) => {
    if (!deliver) return false;
    if (!accepted.has(key)) {
      accepted.add(key);
      notices.push(text);
    }
    return true;
  };
  const deps = { wake: receive };
  for (let tick = 10; tick < 13; tick++) await sweep(spawn, deps)(tick);
  expect(merges()).toHaveLength(3);
  expect(notices).toEqual([]);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toEqual([]);
  ledger = new CodingPrLedgerRepository(db);
  deliver = true;
  await sweep(spawn, deps)(13);
  await sweep(spawn, deps)(14);
  expect(merges()).toHaveLength(3);
  expect(notices).toEqual([expect.stringContaining('Required check still settling')]);
  expect(notices[0]).toContain('3 failed attempts');
  expect(notices[0]).toContain(url);
  expect(notices[0]).toContain(head);
  actualHead = 'b'.repeat(40);
  reviewHead = actualHead;
  mergeFailed = false;
  const rows = await ledger.read('list');
  await ledger.write('replace', 'synthetic/merge', [{ ...rows[0], head: actualHead }], 15);
  await sweep(spawn, deps)(16);
  expect(merges()).toHaveLength(4);
  expect(merges()[3].at(-1)).toBe(actualHead);
  expect(notices.filter((text) => text.includes('Merge confirmed:'))).toHaveLength(1);
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

test('a successful CLI exit with a fresh OPEN PR releases its receipt for retry', async () => {
  mergeFailed = true;
  const open: SpawnFn = (args) => {
    const result = spawn(args);
    return args[2] === 'merge' ? { ...result, exited: Promise.resolve(0), exitCode: 0 } : result;
  };
  await sweep(open)(10);
  mergeFailed = false;
  await sweep()(11);
  expect(merges()).toHaveLength(2);
  expect(notices.filter((text) => text.includes('Merge confirmed:'))).toHaveLength(1);
});

test('recovery does not count a failure twice after interruption before receipt release', async () => {
  const [receipt] = await reserve(2);
  await ledger.write('daemonMerge', {
    ...receipt,
    kind: 'failed',
    at: receipt.startedAt,
    error: 'interrupted failure',
  });
  await sweep()(10);
  expect(merges()).toHaveLength(1);
  expect(await ledger.write('daemonMerge', { kind: 'failures', url, head })).toMatchObject([
    { failures: 1 },
  ]);
});

test('retry budget is enforced even when successive sweeps share a timestamp', async () => {
  mergeFailed = true;
  for (let attempt = 0; attempt < 5; attempt++) await sweep()(10);
  expect(merges()).toHaveLength(3);
});

test('an observed merge wins over a command error and is never retried', async () => {
  const uncertain: SpawnFn = (args) => {
    const result = spawn(args);
    return args[2] === 'merge' ? { ...result, exited: Promise.resolve(1), exitCode: 1 } : result;
  };
  await sweep(uncertain)(10);
  await sweep(uncertain)(11);
  expect(merges()).toHaveLength(1);
  expect(notices.filter((text) => text.includes('Merge confirmed:'))).toHaveLength(1);
});

test('a failed CLI reply with unreadable confirmation preserves its receipt and later confirms once', async () => {
  hideOutcome = true;
  const lost: SpawnFn = (args) => {
    const result = spawn(args);
    return args[2] === 'merge'
      ? {
          ...result,
          exited: Promise.resolve(1),
          exitCode: 1,
          stderr: new Response('Connection lost after merge').body,
        }
      : result;
  };
  await sweep(lost)(10);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toHaveLength(1);
  expect(await ledger.write('daemonMerge', { kind: 'failures', url, head })).toEqual([]);
  hideOutcome = false;
  await sweep(lost)(11);
  await sweep(lost)(12);
  expect(merges()).toHaveLength(1);
  expect(notices.filter((text) => text.includes('Merge confirmed:'))).toHaveLength(1);
});

test('an unreadable failed third attempt keeps its error until OPEN recovery surfaces the limit', async () => {
  for (const at of [1, 2]) {
    const [receipt] = await reserve(at);
    await ledger.write('daemonMerge', {
      ...receipt,
      kind: 'failed',
      at: receipt.startedAt,
      error: 'Earlier failure',
    });
    await ledger.write('daemonMerge', { ...receipt, kind: 'void', at: receipt.startedAt });
  }
  mergeFailed = true;
  const accepted = new Set<string>();
  const wake = async (key: string, text: string) => {
    if (!accepted.has(key)) {
      accepted.add(key);
      notices.push(text);
    }
    return true;
  };
  let issued = false;
  const unreadable: SpawnFn = (args) => {
    if (args[2] === 'merge') issued = true;
    const result = spawn(args);
    return issued && args[2] === 'view'
      ? { ...result, exited: Promise.resolve(1), exitCode: 1 }
      : result;
  };
  await sweep(unreadable, { wake })(10);
  expect(await ledger.write('daemonMerge', { kind: 'list' })).toHaveLength(1);
  expect(notices).toEqual([]);
  await sweep(spawn, { wake })(11);
  expect(merges()).toHaveLength(1);
  expect(notices).toEqual([expect.stringContaining('Required check still settling')]);
  expect(notices[0]).toContain('3 failed attempts');
});

test('an undelivered retry-limit notice survives removal from the candidate set', async () => {
  mergeFailed = true;
  const { run, wakes } = entry();
  for (const at of [10, 11, 12]) await sweep(spawn, { attend: async () => false })(at);
  expect(merges()).toHaveLength(3);
  policy('mergeBy', 'owner');
  await run(13);
  expect(wakes()).toEqual([]);
  await completeRead(14);
  await run(14);
  await run(15);
  expect(merges()).toHaveLength(3);
  expect(wakes()).toEqual([expect.stringContaining('3 failed attempts')]);
  expect(wakes()[0]).toContain('Required check still settling');
});

test('an external merge after a failed attempt still notifies its owner through ledger events', async () => {
  const owner = { adapter: 'hyperneo', id: 'fixture-owner' };
  db.prepare('UPDATE pack_coding_pr_ledger SET owner=?').run(JSON.stringify(owner));
  mergeFailed = true;
  await sweep()(10);
  expect(merges()).toHaveLength(1);
  const rows = await ledger.read('list');
  const transitions = await ledger.write(
    'replace',
    'synthetic/merge',
    [{ ...rows[0], state: 'merged', closedAt: 11 }],
    11
  );
  const receive = async (_owner: unknown, _key: string, text: string) => {
    notices.push(text);
    return true;
  };
  const events = new CodingPrEventRepository(db);
  await deliverCodingPrEvents(events, transitions, {
    host: 'github.com',
    tell: receive,
    wake: async () => false,
  });
  await deliverCodingPrEvents(events, [], {
    host: 'github.com',
    tell: receive,
    wake: async () => false,
  });
  expect(notices).toEqual([expect.stringContaining('was merged on head')]);
  expect(merges()).toHaveLength(1);
});

const FOUR_HOURS = 4 * 3_600_000;

test('a sign-off hold wakes Neo once per head through the attention entry', async () => {
  labels = ['human-merge'];
  const { run, wakes } = entry();
  await run(10);
  await run(600_010);
  await run(1_200_010);
  expect(wakes()).toEqual([expect.stringContaining(`${url} requires human sign-off`)]);
  actualHead = reviewHead = 'b'.repeat(40);
  const rows = await ledger.read('list');
  await ledger.write('replace', 'synthetic/merge', [{ ...rows[0], head: actualHead }], 1_200_011);
  await run(1_200_012);
  expect(wakes()).toHaveLength(2);
  expect(merges()).toHaveLength(0);
});

test('a stopped merge budget wakes Neo once and once more after four hours', async () => {
  mergeFailed = true;
  const { run, wakes } = entry();
  for (const at of [10, 11, 12, 13, 14]) await run(at);
  expect(merges()).toHaveLength(3);
  expect(wakes()).toEqual([expect.stringContaining('3 failed attempts')]);
  await run(12 + FOUR_HOURS - 1);
  expect(wakes()).toHaveLength(1);
  await run(12 + FOUR_HOURS);
  await run(13 + FOUR_HOURS);
  await run(12 + 6 * FOUR_HOURS);
  expect(wakes()).toHaveLength(2);
  expect(wakes()[1]).toContain('Required check still settling');
  expect(merges()).toHaveLength(3);
});

test.each(['closed', 'new head'])(
  'a stopped merge budget is not repeated once its pull request is %s',
  async (change) => {
    mergeFailed = true;
    const { run, wakes } = entry();
    for (const at of [10, 11, 12]) await run(at);
    expect(wakes()).toHaveLength(1);
    const rows = await ledger.read('list');
    if (change === 'new head') ci = 'pending';
    await ledger.write(
      'replace',
      'synthetic/merge',
      [
        change === 'closed'
          ? { ...rows[0], state: 'merged', closedAt: 13 }
          : { ...rows[0], head: (actualHead = reviewHead = 'b'.repeat(40)) },
      ],
      13
    );
    await run(12 + FOUR_HOURS);
    expect(wakes()).toHaveLength(1);
    expect(merges()).toHaveLength(3);
  }
);

test('gates passing again after a stopped budget tell Neo once per time they pass', async () => {
  mergeFailed = true;
  const { run, wakes } = entry();
  for (const at of [10, 11, 12]) await run(at);
  const ready = (since: number) =>
    db.prepare("UPDATE pack_coding_pr_ledger SET state='approved_green', state_since=?").run(since);
  ready(20);
  await run(21);
  await run(22);
  expect(wakes()).toEqual([
    expect.stringContaining('3 failed attempts'),
    expect.stringContaining('Fresh merge gates now pass'),
  ]);
  ready(30);
  await run(31);
  expect(wakes()).toHaveLength(3);
  expect(merges()).toHaveLength(3);
});

test('a failed fresh read sends no ready cue and each report repeats once', async () => {
  mergeFailed = true;
  const { run, wakes } = entry();
  for (const at of [10, 11, 12]) await run(at);
  db.prepare("UPDATE pack_coding_pr_ledger SET state='approved_green', state_since=20").run();
  fail = '/reviews';
  await run(21);
  expect(wakes()).toHaveLength(1);
  fail = '';
  await run(22);
  await completeRead(12 + FOUR_HOURS);
  await run(12 + FOUR_HOURS);
  await run(20 + FOUR_HOURS);
  await run(20 + 6 * FOUR_HOURS);
  expect(wakes().map((text) => text.includes('Fresh merge gates now pass'))).toEqual([
    false,
    true,
    false,
    true,
  ]);
  expect(merges()).toHaveLength(3);
});

test.each(['failed', 'partial', 'cooldown'] as const)(
  'an undelivered stopped report is not sent for a pull request closed behind a %s ledger read',
  async (outcome) => {
    mergeFailed = true;
    const { run, wakes } = entry();
    for (const at of [10, 11, 12]) await sweep(spawn, { attend: async () => false })(at);
    expect(merges()).toHaveLength(3);
    state = 'CLOSED';
    await ledger.write('recordHealth', 'synthetic/merge', {
      at: 13,
      outcome,
      ...(outcome === 'cooldown' ? { retryAt: 1_000_000 } : {}),
    });
    expect((await ledger.read('list'))[0].closedAt).toBeNull();
    await run(14);
    await run(15);
    expect(wakes()).toEqual([]);
    const rows = await ledger.read('list');
    await ledger.write('recordHealth', 'synthetic/merge', { at: 16, outcome: 'complete' });
    await ledger.write(
      'replace',
      'synthetic/merge',
      [{ ...rows[0], state: 'closed', closedAt: 16 }],
      16
    );
    await run(17);
    await run(12 + FOUR_HOURS);
    expect(wakes()).toEqual([]);
    expect(merges()).toHaveLength(3);
  }
);

test('an undelivered stopped report is not sent on complete health kept from a later clock', async () => {
  mergeFailed = true;
  const { run, wakes } = entry();
  for (const at of [10, 11, 12]) await sweep(spawn, { attend: async () => false })(at);
  expect(merges()).toHaveLength(3);
  policy('mergeBy', 'owner');
  await completeRead(20);
  state = 'CLOSED';
  for (const at of [15, 16]) {
    await ledger.write('observePoll', 'synthetic/merge', { error: 'lookup failed' }, at, at, []);
    expect((await ledger.pollContextCurrent('synthetic/merge')).health).toMatchObject({
      reason: 'complete',
      cycleAt: 20,
    });
    expect((await ledger.read('list'))[0]).toMatchObject({ closedAt: null, readAt: 20 });
    await run(at);
  }
  expect(wakes()).toEqual([]);
  const rows = await ledger.read('list');
  await ledger.write('recordHealth', 'synthetic/merge', { at: 21, outcome: 'complete' });
  await ledger.write(
    'replace',
    'synthetic/merge',
    [{ ...rows[0], state: 'closed', closedAt: 21 }],
    21
  );
  await run(21);
  await run(12 + FOUR_HOURS);
  expect(wakes()).toEqual([]);
  expect(merges()).toHaveLength(3);
});

test('the merge sweep keeps no record of what it told Neo', () => {
  db.exec(
    'CREATE TABLE pack_coding_daemon_merge_notices (url TEXT, head TEXT, kind TEXT, at INTEGER)'
  );
  const columns = () =>
    (
      db.prepare('PRAGMA table_info(pack_coding_daemon_merge_failures)').all() as {
        name: string;
      }[]
    ).map((column) => column.name);
  if (!columns().includes('notified_at'))
    db.exec('ALTER TABLE pack_coding_daemon_merge_failures ADD COLUMN notified_at INTEGER');
  createCodingPackTables(db);
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'pack_coding_daemon_merge_notices'")
      .all()
  ).toEqual([]);
  expect(columns()).not.toContain('notified_at');
});

test.each([null, 'Synthetic lost reply'])(
  'an unconfirmed receipt of a closed pull request is told once and released, error=%s',
  async (error) => {
    const [receipt] = await reserve(2);
    if (error)
      await ledger.write('daemonMerge', {
        ...receipt,
        kind: 'uncertain',
        at: receipt.startedAt,
        error,
      });
    state = 'CLOSED';
    const { run, wakes } = entry();
    await run(10);
    await run(11);
    expect(wakes()).toEqual([expect.stringContaining('Daemon merge held:')]);
    expect(wakes()[0]).toContain(`${url} head ${head}`);
    expect(wakes()[0]).toContain('no longer open');
    expect(wakes()[0]).not.toMatch(/receipt|retries are held/);
    expect(wakes()[0].includes('Last error: Synthetic lost reply.')).toBe(error !== null);
    expect(db.prepare('SELECT count(*) AS n FROM pack_coding_daemon_merges').get()).toEqual({
      n: 0,
    });
  }
);
