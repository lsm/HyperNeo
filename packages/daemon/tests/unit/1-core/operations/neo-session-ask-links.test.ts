import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { PlaceGroup, WorkStatus } from '../../../../src/lib/drivers/types.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  describeNeoAskSessions,
  keepNeoSessionPrs,
  linkNeoSessionsToAsks,
  NEO_SESSION_PR_READS_MAX,
  NEO_SESSION_PR_RECHECK_MS,
  neoAskPrKeys,
  planNeoHeldSessionNotices,
  planNeoSessionPrReads,
  unmutedNeoAskSessions,
} from '../../../../src/lib/neo/session-ask-links.ts';
import { type NeoListedSession, neoSessionKey } from '../../../../src/lib/neo/session-watch.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const pr = (number: number) => `https://github.com/lsm/HyperNeo/pull/${number}`;
const listed = (id: string, overrides: Partial<NeoListedSession> = {}): NeoListedSession => ({
  key: neoSessionKey({ adapter: 'codex-desktop', id }),
  ref: { adapter: 'codex-desktop', id },
  title: id,
  status: 'running',
  lastActivityAt: 1,
  link: `codex://threads/${id}`,
  ...overrides,
});
const askText = (overrides: Partial<NeoAsk> = {}) => ({
  ask: 'Ship it',
  doneWhen: 'merged',
  outcome: null,
  evidence: null,
  doneItems: [],
  ...overrides,
});
const evidence = (key: string) => ({ key, state: 'pending' as const, summary: '', blockers: [] });

describe('planNeoSessionPrReads', () => {
  test('reads sessions with no known PRs, those needing the human first, within a bound', () => {
    const sessions = [
      listed('known'),
      listed('reading'),
      listed('old', { lastActivityAt: 1 }),
      listed('new', { lastActivityAt: 5 }),
      listed('stuck', { status: 'needs_you', lastActivityAt: 0 }),
    ];
    const checked = new Map([[sessions[0]!.key, 100]]);
    const plan = planNeoSessionPrReads(
      sessions,
      new Map([[sessions[0]!.key, []]]),
      [sessions[1]!],
      checked,
      100
    );
    expect(plan.map((session) => session.title)).toEqual(['stuck', 'new', 'old']);
    const many = Array.from({ length: NEO_SESSION_PR_READS_MAX + 3 }, (_, i) => listed(`s${i}`));
    expect(planNeoSessionPrReads(many, new Map(), [], new Map(), 0)).toHaveLength(
      NEO_SESSION_PR_READS_MAX
    );
  });

  test('reads every known session again after a while, so later PRs are found too', () => {
    const empty = listed('empty');
    const found = listed('found');
    const known = new Map([
      [empty.key, []],
      [found.key, ['https://github.com/o/r/pull/1']],
    ]);
    const checked = new Map([
      [empty.key, 0],
      [found.key, 0],
    ]);
    expect(planNeoSessionPrReads([empty, found], known, [], checked, 1)).toEqual([]);
    expect(
      planNeoSessionPrReads([empty, found], known, [], checked, NEO_SESSION_PR_RECHECK_MS).map(
        (session) => session.title
      )
    ).toEqual(['empty', 'found']);
  });
});

describe('keepNeoSessionPrs', () => {
  test('adds what a read found to what was known, once per PR', () => {
    const kept = keepNeoSessionPrs(
      new Map([['a', [pr(1)]]]),
      new Map([
        ['a', [pr(1).toUpperCase(), pr(2)]],
        ['b', []],
      ])
    );
    expect(kept).toEqual(
      new Map([
        ['a', [pr(1).toUpperCase(), pr(2)]],
        ['b', []],
      ])
    );
  });
});

describe('neoAskPrKeys', () => {
  test("keys the ask's card PRs and the PRs its items name", () => {
    const keys = neoAskPrKeys(
      askText({
        doneItems: [
          {
            id: 'i',
            text: 'Land lsm/HyperNeo#12',
            state: 'pending',
            evidence: null,
            check: null,
            metBy: null,
            removed: false,
            addedAt: null,
          },
        ],
      }),
      [evidence(pr(7)), evidence('work:w1')]
    );
    expect([...keys]).toEqual([pr(7).toLowerCase(), pr(12).toLowerCase()]);
  });
  test('keys the pull requests its open items watch', () => {
    const item = {
      text: 'Ship it',
      state: 'pending' as const,
      evidence: null,
      check: null,
      metBy: null,
      addedAt: null,
    };
    const keys = neoAskPrKeys(
      askText({
        doneItems: [
          {
            ...item,
            id: 'i1',
            removed: false,
            watch: [pr(30), 'https://github.com/lsm/HyperNeo/issues/31'],
          },
          { ...item, id: 'i2', removed: true, watch: [pr(32)] },
        ],
      }),
      []
    );
    expect([...keys]).toEqual([pr(30).toLowerCase()]);
  });
});

describe('linkNeoSessionsToAsks', () => {
  const asks = [
    { id: 'owned', status: 'open' as const, prs: new Set([pr(7).toLowerCase()]) },
    { id: 'named', status: 'waiting' as const, prs: new Set([pr(12).toLowerCase()]) },
    { id: 'done', status: 'achieved' as const, prs: new Set([pr(7).toLowerCase()]) },
  ];

  test('links a session to each open ask one of its PRs serves', () => {
    const links = linkNeoSessionsToAsks(
      asks,
      new Map([
        ['s1', [pr(7).toUpperCase()]],
        ['s2', [pr(12), pr(99)]],
        ['s3', [pr(99)]],
      ])
    );
    expect(links).toEqual([
      { askId: 'owned', key: 's1' },
      { askId: 'named', key: 's2' },
    ]);
  });
});

describe('planNeoHeldSessionNotices', () => {
  const notice = (key: string, kind: 'needs_you' | 'failed') => ({
    key,
    ref: { adapter: 'codex-desktop', id: key },
    title: key,
    kind,
    at: 1,
  });

  test('holds a linked session notice and posts it once the link ends while it still applies', () => {
    const first = planNeoHeldSessionNotices(
      new Map(),
      [notice('a', 'needs_you'), notice('b', 'failed')],
      new Set(['a']),
      (key) => (key === 'a' ? 'needs_you' : 'failed')
    );
    expect(first.notices.map((item) => item.key)).toEqual(['b']);
    expect([...first.held.keys()]).toEqual(['a']);
    const settled = planNeoHeldSessionNotices(first.held, [], new Set(), () => 'needs_you');
    expect(settled.notices.map((item) => item.key)).toEqual(['a']);
    expect(settled.held.size).toBe(0);
  });

  test('a held notice for a session muted or gone from the listing is dropped, never posted', () => {
    const held = new Map([['a', notice('a', 'needs_you')]]);
    const gone = planNeoHeldSessionNotices(held, [], new Set(), () => undefined);
    expect([gone.notices, gone.held.size]).toEqual([[], 0]);
  });

  test('drops a held notice once the session no longer needs the human or is gone', () => {
    const held = new Map([['a', notice('a', 'needs_you')]]);
    expect(planNeoHeldSessionNotices(held, [], new Set(['a']), () => 'running').held.size).toBe(0);
    expect(planNeoHeldSessionNotices(held, [], new Set(), () => undefined).notices).toEqual([]);
  });
});

describe('unmutedNeoAskSessions', () => {
  test('drops a muted session from every ask at once, before the next watch pass', () => {
    const view = (key: string) => ({
      key,
      title: key,
      adapter: 'codex-desktop',
      status: 'needs_you' as const,
      kind: 'needs_you' as const,
      open: { link: null, remoteLink: null, sessionId: null, daemon: null },
    });
    const shown = unmutedNeoAskSessions(new Map([['ask-1', [view('a'), view('b')]]]), ['a']);
    expect(shown.get('ask-1')?.map((item) => item.key)).toEqual(['b']);
  });
});

describe('describeNeoAskSessions', () => {
  test("shows a linked session's status, whether it needs the human, and how to open it", () => {
    const sessions = [
      listed('t1', { remoteLink: 'https://claude.ai/code/session_1' }),
      listed('t2'),
      { ...listed('h1'), ref: { adapter: 'hyperneo', id: 'h1' }, link: '/session/h1' },
    ];
    const views = describeNeoAskSessions(
      [
        { askId: 'a', key: sessions[0]!.key },
        { askId: 'a', key: sessions[1]!.key },
        { askId: 'b', key: sessions[2]!.key },
        { askId: 'b', key: 'gone' },
      ],
      sessions,
      (session) => (session.title === 't1' ? 'needs_you' : session.status)
    );
    expect(views.get('a')).toEqual([
      {
        key: sessions[0]!.key,
        title: 't1',
        adapter: 'codex-desktop',
        status: 'needs_you',
        kind: 'needs_you',
        open: {
          link: 'codex://threads/t1',
          remoteLink: 'https://claude.ai/code/session_1',
          sessionId: null,
          daemon: null,
        },
      },
      expect.objectContaining({ title: 't2', status: 'running', kind: null }),
    ]);
    expect(views.get('b')).toEqual([
      expect.objectContaining({
        adapter: 'hyperneo',
        open: { link: '/session/h1', remoteLink: null, sessionId: 'h1', daemon: null },
      }),
    ]);
  });
});

describe('NeoService session ask links', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let sessions: PlaceGroup['work'];
  let status: { status: WorkStatus; lastActivityAt: number; openedPrs?: string[] };
  const events: Array<[string, unknown]> = [];
  const ref = { adapter: 'codex-desktop', id: 't1' };
  const key = neoSessionKey(ref);
  const human = { source: 'rpc' as const, principal: 'local' as const };
  const invoke = (name: string, input: unknown) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, human);
  const askViews = async () => {
    const snapshot = await invoke('neo.snapshot', {});
    return 'value' in snapshot
      ? (snapshot.value as { askViews: Record<string, unknown>[] }).askViews
      : [];
  };
  const watch = async (state: WorkStatus, at: number, openedPrs: string[]) => {
    sessions = [
      {
        ref,
        title: 'Ship the fix',
        place: { machine: 'laptop', folder: '/repo', name: 'repo' },
        status: state,
        lastActivityAt: at,
        link: 'codex://threads/t1',
      },
    ];
    status = { status: state, lastActivityAt: at, openedPrs };
    await service.refreshDriverWork();
  };
  const notices = () => events.filter(([name]) => name === 'neo.session.notice');

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('neo:root'));
    events.length = 0;
    sessions = [];
    status = { status: 'running', lastActivityAt: 0 };
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.find',
        description: 'test find',
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          places: [
            {
              place: { machine: 'laptop', folder: '/repo', name: 'repo' },
              lastActivityAt: Date.now(),
              openCount: sessions.length,
              archivedCount: 0,
              adapters: ['codex-desktop'],
              work: sessions,
            },
          ],
          unreachable: [],
        }),
      }),
      defineOperation({
        name: 'work.status',
        description: 'test status',
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async (input: Record<string, unknown>) =>
          (input.ref as { id?: string }).id === 't1'
            ? { ok: true, value: status }
            : { ok: false, reason: 'not_found', detail: 'gone' },
      }),
    ]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      {
        event: mock((name: string, payload: unknown) => {
          events.push([name, payload]);
        }),
      } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.readPrs = async () => [];
    service.readRefStates = async () => [];
    service.readBranchPrs = async () => [];
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    db.createSession(createTestSession('neo:inbox'));
    service.repo.saveProject({ id: 'inbox', title: 'Inbox', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: 'neo:inbox', kind: 'project', projectId: 'inbox' });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  const openAsk = (ask: string) =>
    service.askRecords.open({
      id: 'a1',
      requestKey: 'k1',
      projectId: null,
      originSessionId: 'neo:root',
      originMessageId: 'm0',
      title: 'Ship the fix',
      ask,
      doneWhen: 'merged',
      doneSource: 'human',
    })!;

  test('a linked session keeps its attention facts without inventing an ask question', async () => {
    const opened = openAsk('Ship the fix');
    service.driverTargets.propose(
      service.repo,
      {
        id: 'w1',
        requestKey: 'root:w1',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Ship the fix',
        instruction: 'Fix it.',
      },
      { verb: 'send', ref: { adapter: 'hyperneo', id: 'card-session' } }
    );
    const queued = service.repo.transitionWork('w1', service.repo.getWork('w1')!, {
      status: 'queued',
    })!;
    service.repo.transitionWork('w1', queued, { status: 'reported', report: 'Opened the PR.' });
    service.askRecords.link(opened.id, 'w1');
    service.workPrs.record(
      'w1',
      [{ url: pr(7), state: 'OPEN', checks: 'pending', review: 'none' }],
      Date.now()
    );
    const now = Date.now();
    await watch('running', now - 2_000, [pr(7)]);
    expect((await askViews())[0]).toMatchObject({
      group: 'running',
      needsYou: false,
      sessions: [{ key, status: 'running', kind: null }],
    });

    await watch('needs_you', now - 1_000, [pr(7)]);
    expect(notices()).toEqual([]);
    expect((await askViews())[0]).toMatchObject({
      group: 'running',
      label: 'In progress',
      needsYou: false,
      sessions: [
        {
          key,
          title: 'Ship the fix',
          adapter: 'codex-desktop',
          status: 'needs_you',
          kind: 'needs_you',
          open: { link: 'codex://threads/t1', remoteLink: null, sessionId: null, daemon: null },
        },
      ],
    });
  });

  test('a linked session already waiting keeps its facts while the ask waits for a real question', async () => {
    openAsk(`Land ${pr(12)}`);
    const at = Date.now() - 1_000;
    sessions = [
      {
        ref,
        title: 'Ship the fix',
        place: { machine: 'laptop', folder: '/repo', name: 'repo' },
        status: 'running',
        lastActivityAt: at,
        link: 'codex://threads/t1',
      },
    ];
    status = { status: 'needs_you', lastActivityAt: at, openedPrs: [pr(12)] };
    await service.refreshDriverWork();
    expect((await askViews())[0]).toMatchObject({
      group: 'running',
      label: 'Not started',
      needsYou: false,
      sessions: [{ key, kind: 'needs_you' }],
    });
  });

  test('a PR a session without a todo opened gets that session as its ledger owner', async () => {
    const raw = db.getDatabase();
    raw
      .prepare(
        `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, read_at)
         VALUES (?, 12, 'Fix', 'b', 'h', 'waiting_review', 1, 1)`
      )
      .run(pr(12).split('/').slice(3, 5).join('/').toLowerCase());
    await watch('running', Date.now() - 1_000, [pr(12)]);
    expect(raw.prepare('SELECT owner FROM pack_coding_pr_ledger').get()).toEqual({
      owner: JSON.stringify(ref),
    });
    await watch('running', Date.now() - 500, []);
    expect(raw.prepare('SELECT owner FROM pack_coding_pr_ledger').get()).toEqual({
      owner: JSON.stringify(ref),
    });
  });

  test('a session whose PR the ask names in its text is linked too', async () => {
    openAsk(`Land ${pr(12)}`);
    const now = Date.now();
    await watch('running', now - 2_000, [pr(12)]);
    await watch('failed', now - 1_000, [pr(12)]);
    expect(notices()).toEqual([]);
    expect((await askViews())[0]).toMatchObject({
      group: 'running',
      label: 'Not started',
      needsYou: false,
      sessions: [{ key, kind: 'failed' }],
    });
  });

  test('a session with unrelated PRs keeps its loose notice and stays off the ask', async () => {
    openAsk(`Land ${pr(12)}`);
    const now = Date.now();
    await watch('running', now - 2_000, [pr(99)]);
    await watch('needs_you', now - 1_000, [pr(99)]);
    expect(notices()).toEqual([
      ['neo.session.notice', expect.objectContaining({ key, kind: 'needs_you' })],
    ]);
    expect((await askViews())[0]).toMatchObject({ needsYou: false, sessions: [] });
  });

  test('muting a linked session that needs the human never posts its held notice', async () => {
    openAsk(`Land ${pr(12)}`);
    const now = Date.now();
    await watch('running', now - 3_000, [pr(12)]);
    await watch('needs_you', now - 2_000, [pr(12)]);
    expect(notices()).toEqual([]);
    await invoke('neo.session.mute', { key, muted: true });
    await watch('needs_you', now - 1_000, [pr(12)]);
    expect(notices()).toEqual([]);
  });

  test('a muted session neither shows on the ask nor sends a notice', async () => {
    openAsk(`Land ${pr(12)}`);
    await invoke('neo.session.mute', { key, muted: true });
    const now = Date.now();
    await watch('running', now - 2_000, [pr(12)]);
    await watch('needs_you', now - 1_000, [pr(12)]);
    expect(notices()).toEqual([]);
    expect((await askViews())[0]).toMatchObject({ needsYou: false, sessions: [] });
  });
});
