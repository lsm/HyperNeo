import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_ASK_EVIDENCE } from '@hyperneo/prompts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoAskEvidenceMessageId,
  neoAskEvidenceNote,
  planNeoAskEvidenceNote,
  requireNeoAskEvidenceDue,
  NEO_ASK_EVIDENCE_READ_MS,
} from '../../../../src/lib/neo/ask-evidence.ts';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';
import {
  extractNeoAskRefs,
  neoAskRefNews,
  readGithubRefStates,
  type NeoRef,
  type NeoRefState,
} from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { readNeoAskPackEvidence } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const url = (n: number, repo = 'lsm/HyperNeo') => `https://github.com/${repo}/pull/${n}`;
const ask: NeoAsk = {
  id: 'a1',
  requestKey: 'k1',
  concernId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Voice composer decisions',
  ask: 'Decide the choices in the design (PR lsm/HyperNeo#6159, unmerged); see #21 iOS.',
  doneWhen: 'The human picks a direction.',
  doneSource: 'human',
  status: 'waiting',
  outcome: 'Waiting on you: 5 decisions.',
  evidence: `Design in ${url(6159)}; context ${url(32, 'lsm/neo-ios')}.`,
  createdAt: 100,
  updatedAt: 100,
  settledAt: 100,
  workIds: [],
  doneItems: [
    {
      id: 'i1',
      text: 'Bar position chosen',
      state: 'needs_you',
      evidence: 'See lsm/HyperNeo#6205',
      check: null,
      metBy: null,
      removed: false,
      addedAt: null,
    },
  ],
};
const ref = (number: number, repo = 'HyperNeo', owner = 'lsm'): NeoRef => ({ owner, repo, number });
const merged = (n: number, at: number): NeoRefState => ({
  url: url(n),
  kind: 'pr',
  state: 'MERGED',
  at,
  done: true,
  closedBy: null,
});
const news = (n: number): NeoEvidence => ({
  key: url(n),
  state: 'done',
  summary: 'merged',
  blockers: [],
});

describe('extractNeoAskRefs', () => {
  test('takes URLs and owner/repo#N, and leaves bare #N alone when the ask names two repos', () => {
    expect(extractNeoAskRefs(ask, [])).toEqual([ref(6159), ref(32, 'neo-ios'), ref(6205)]);
  });

  test('leaves out pull requests the ask cards already track', () => {
    expect(extractNeoAskRefs(ask, [url(6159)])).toEqual([ref(32, 'neo-ios'), ref(6205)]);
  });

  test('resolves bare #N against the one repo the ask and its cards point at', () => {
    const plain = { ...ask, ask: 'Fix HyperNeo #5546', evidence: null, doneItems: [] };
    expect(extractNeoAskRefs(plain, [url(6300)])).toEqual([ref(5546)]);
    expect(extractNeoAskRefs(plain, [])).toEqual([]);
    expect(
      extractNeoAskRefs(
        { ...plain, outcome: 'See https://github.com/lsm/HyperNeo/issues/5546' },
        []
      )
    ).toEqual([ref(5546)]);
  });
});

describe('neoAskRefNews', () => {
  const issue = (overrides: Partial<NeoRefState>): NeoRefState => ({
    url: 'https://github.com/lsm/HyperNeo/issues/1',
    kind: 'issue',
    state: 'CLOSED',
    at: 200,
    done: true,
    closedBy: null,
    ...overrides,
  });
  test.each<[string, NeoRefState, NeoEvidence[]]>([
    ['a pull request merged after the ask opened', merged(1, 200), [news(1)]],
    ['a pull request merged before the ask opened', merged(1, 50), []],
    [
      'a pull request closed unmerged',
      { ...merged(1, 200), state: 'CLOSED', done: false },
      [{ key: url(1), state: 'failed', summary: 'closed unmerged', blockers: [] }],
    ],
    ['a pull request still open', { ...merged(1, 200), state: 'OPEN', at: null }, []],
    [
      'an issue closed by a pull request',
      issue({ closedBy: url(7) }),
      [
        {
          key: 'https://github.com/lsm/HyperNeo/issues/1',
          state: 'done',
          summary: `closed as completed by ${url(7)}`,
          blockers: [],
        },
      ],
    ],
    [
      'an issue closed as not planned',
      issue({ done: false }),
      [
        {
          key: 'https://github.com/lsm/HyperNeo/issues/1',
          state: 'failed',
          summary: 'closed as not planned',
          blockers: [],
        },
      ],
    ],
  ])('%s', (_label, state, evidence) => {
    expect(neoAskRefNews([state], 100)).toEqual(evidence);
  });
});

describe('readGithubRefStates', () => {
  test('reads pull requests and issues, keeps a merge, skips non-refs, retries the rest', async () => {
    const asked: number[] = [];
    const node = (number: number) =>
      number === 9001
        ? {
            __typename: 'PullRequest',
            url: url(9001),
            state: 'MERGED',
            mergedAt: '2026-10-10T14:31:00Z',
            closedAt: '2026-10-10T14:31:00Z',
          }
        : number === 9002
          ? {
              __typename: 'Issue',
              url: 'https://github.com/lsm/HyperNeo/issues/9002',
              state: 'CLOSED',
              stateReason: 'COMPLETED',
              closedAt: '2026-10-10T15:00:00Z',
              closedByPullRequestsReferences: { nodes: [{ url: url(9001), merged: true }] },
            }
          : null;
    const spawn = (args: string[]) => {
      const number = Number(args.at(-1)?.slice(2));
      asked.push(number);
      const found = node(number);
      return {
        stdout: new Response(
          found ? JSON.stringify({ data: { repository: { issueOrPullRequest: found } } }) : ''
        ).body,
        stderr: new Response(
          found
            ? ''
            : number === 9003
              ? 'GraphQL: Could not resolve to an issue or pull request with the number of 9003.'
              : 'gh: To get started with GitHub CLI, please run: gh auth login'
        ).body,
        exited: Promise.resolve(found ? 0 : 1),
        exitCode: found ? 0 : 1,
        kill: () => {},
      };
    };
    const refs = [ref(9001), ref(9002), ref(9003), ref(9004)];
    expect(await readGithubRefStates(refs, spawn as never)).toEqual([
      merged(9001, Date.parse('2026-10-10T14:31:00Z')),
      {
        url: 'https://github.com/lsm/HyperNeo/issues/9002',
        kind: 'issue',
        state: 'CLOSED',
        at: Date.parse('2026-10-10T15:00:00Z'),
        done: true,
        closedBy: url(9001),
      },
    ]);
    await readGithubRefStates(refs, spawn as never);
    expect([9001, 9002, 9003, 9004].map((n) => asked.filter((m) => m === n).length)).toEqual([
      1, 2, 1, 2,
    ]);
  });
});

describe('readAskEvidence', () => {
  test('reports what the ask names that merged or closed since it opened', async () => {
    const read: NeoRef[][] = [];
    const pack = createCodingPack({
      readPrs: async () => [],
      readRefStates: async (refs) => {
        read.push([...refs]);
        return [merged(6159, 200), merged(6205, 50)];
      },
      workPrs: {
        get: () => null,
        list: () => [{ workId: 'w1', prs: [{ url: url(32, 'lsm/neo-ios') }] }] as never,
        recordFailedRead: () => {},
      },
      record: () => null,
    });
    expect(await pack.readAskEvidence!({ ...ask, workIds: ['w1'] })).toEqual([news(6159)]);
    expect(read).toEqual([[ref(6159), ref(6205)]]);
  });
});

describe('readNeoAskPackEvidence', () => {
  const pack = (id: string, read: () => Promise<NeoEvidence[]>): NeoPack => ({
    id,
    describe: id,
    instructions: () => null,
    readAskEvidence: read,
  });
  test("reads the ask's own pack, or every pack for an ask without one, and skips a failing pack", async () => {
    const warned: string[] = [];
    const packs = [
      pack('coding', async () => [news(1)]),
      pack('broken', async () => {
        throw new Error('down');
      }),
      { id: 'quiet', describe: 'quiet', instructions: () => null },
    ];
    expect(await readNeoAskPackEvidence(packs, ask, (id) => warned.push(id))).toEqual([news(1)]);
    expect(warned).toEqual(['broken']);
    expect(
      await readNeoAskPackEvidence(packs, { ...ask, pack: 'broken' }, (id) => warned.push(id))
    ).toEqual([]);
  });
});

describe('requireNeoAskEvidenceDue', () => {
  const card = { readAt: undefined, session: true };
  test.each<[string, NeoAsk, typeof card | { readAt: number; session: boolean }, boolean]>([
    ['a live ask never read', ask, card, true],
    ['a live ask read a while ago', ask, { readAt: 0, session: true }, true],
    ['a live ask read just now', ask, { readAt: NEO_ASK_EVIDENCE_READ_MS, session: true }, false],
    ['a settled ask', { ...ask, status: 'achieved' }, card, false],
    ['an ask whose session is gone', ask, { readAt: undefined, session: false }, false],
  ])('%s', (_label, current, read, due) => {
    expect(requireNeoAskEvidenceDue(current, read, NEO_ASK_EVIDENCE_READ_MS + 1)).toEqual(
      due ? { value: current } : { reason: null }
    );
  });
});

describe('planNeoAskEvidenceNote', () => {
  test('tells about new evidence once, and again only when it changes', () => {
    const first = planNeoAskEvidenceNote([news(2), news(1)], null);
    expect(first).toMatchObject({ value: { evidence: [news(1), news(2)] } });
    const signature = 'value' in first ? first.value.signature : '';
    expect(planNeoAskEvidenceNote([news(1), news(2)], { signature })).toEqual({ reason: 'told' });
    expect(planNeoAskEvidenceNote([news(1)], { signature })).toMatchObject({ value: {} });
    expect(planNeoAskEvidenceNote([], null)).toEqual({ reason: 'quiet' });
  });
});

describe('neoAskEvidenceNote', () => {
  test('names the ask and what changed', () => {
    const note = neoAskEvidenceNote(ask, [news(6159)]);
    expect(note.startsWith(NEO_ASK_EVIDENCE)).toBe(true);
    expect(JSON.parse(note.slice(NEO_ASK_EVIDENCE.length + 1))).toEqual({
      askId: 'a1',
      title: ask.title,
      status: 'waiting',
      summary: ask.outcome,
      changed: [{ key: url(6159), summary: 'merged' }],
    });
    expect(neoAskEvidenceMessageId('a1', 'x')).toBe(neoAskEvidenceMessageId('a1', 'x'));
    expect(neoAskEvidenceMessageId('a1', 'x')).not.toBe(neoAskEvidenceMessageId('a1', 'y'));
  });
});

describe('refreshDriverWork', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession('neo:root'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  test('tells the ask session once when a pull request its ask names merges', async () => {
    const opened = service.askRecords.open({
      id: 'a1',
      requestKey: 'k1',
      concernId: null,
      originSessionId: 'neo:root',
      originMessageId: 'm0',
      title: ask.title,
      ask: ask.ask,
      doneWhen: ask.doneWhen,
      doneSource: 'human',
    })!;
    const waiting = service.askRecords.settle(opened, 'waiting', 'Waiting on you.', '')!;
    const states = [merged(6159, opened.createdAt + 1), merged(6205, opened.createdAt + 2)];
    service.readRefStates = async (refs) =>
      states.filter((pr) => refs.some((item) => url(item.number) === pr.url));
    const notes: string[] = [];
    Object.assign(service, {
      deliver: async (_target: string, messageId: string) => {
        notes.push(messageId);
      },
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    await service.refreshDriverWork();
    expect(notes).toHaveLength(1);
    await service.refreshDriverWork();
    now += NEO_ASK_EVIDENCE_READ_MS;
    await service.refreshDriverWork();
    expect(notes).toHaveLength(1);
    expect(service.askChecks.get('a1')).toMatchObject({ askId: 'a1' });

    service.askRecords.settle(waiting, 'waiting', 'Waiting on you: see lsm/HyperNeo#6205.', '');
    now += NEO_ASK_EVIDENCE_READ_MS;
    await service.refreshDriverWork();
    expect(notes).toHaveLength(2);
    expect(notes[1]).not.toBe(notes[0]);
  });
});
