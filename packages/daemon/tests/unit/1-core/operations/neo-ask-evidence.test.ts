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
  extractNeoAskPrUrls,
  neoAskPrNews,
  readGithubPrStates,
  type NeoPrState,
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
const merged = (n: number, at: number): NeoPrState => ({ url: url(n), state: 'MERGED', at });
const news = (n: number): NeoEvidence => ({
  key: url(n),
  state: 'done',
  summary: 'merged',
  blockers: [],
});

describe('extractNeoAskPrUrls', () => {
  test('takes full pull request URLs and owner/repo#N references, never bare #N', () => {
    expect(extractNeoAskPrUrls(ask, new Set())).toEqual([
      url(6159),
      url(32, 'lsm/neo-ios'),
      url(6205),
    ]);
  });

  test('leaves out pull requests the ask cards already track', () => {
    expect(extractNeoAskPrUrls(ask, new Set([url(6159)]))).toEqual([
      url(32, 'lsm/neo-ios'),
      url(6205),
    ]);
  });
});

describe('neoAskPrNews', () => {
  test.each<[string, NeoPrState, NeoEvidence[]]>([
    ['merged after the ask opened', merged(1, 200), [news(1)]],
    ['merged before the ask opened', merged(1, 50), []],
    [
      'closed unmerged after the ask opened',
      { url: url(1), state: 'CLOSED', at: 200 },
      [{ key: url(1), state: 'failed', summary: 'closed unmerged', blockers: [] }],
    ],
    ['still open', { url: url(1), state: 'OPEN', at: null }, []],
  ])('%s', (_label, state, evidence) => {
    expect(neoAskPrNews([state], 100)).toEqual(evidence);
  });
});

describe('readGithubPrStates', () => {
  test('reads each pull request once it settled, skips what is not one, and retries gh failures', async () => {
    const asked: string[] = [];
    const spawn = (args: string[]) => {
      asked.push(args[3]);
      const raw = args[3].endsWith('/9001')
        ? { url: args[3], state: 'MERGED', mergedAt: '2026-10-10T14:31:00Z', closedAt: null }
        : args[3].endsWith('/9002')
          ? { url: args[3], state: 'OPEN', mergedAt: null, closedAt: null }
          : null;
      return {
        stdout: new Response(raw ? JSON.stringify(raw) : '').body,
        stderr: new Response(
          raw
            ? ''
            : args[3].endsWith('/9003')
              ? 'GraphQL: Could not resolve to a PullRequest with the number of 9003.'
              : 'gh: To get started with GitHub CLI, please run: gh auth login'
        ).body,
        exited: Promise.resolve(raw ? 0 : 1),
        exitCode: raw ? 0 : 1,
        kill: () => {},
      };
    };
    const urls = [url(9001), url(9002), url(9003), url(9004)];
    expect(await readGithubPrStates(urls, spawn as never)).toEqual([
      { url: url(9001), state: 'MERGED', at: Date.parse('2026-10-10T14:31:00Z') },
      { url: url(9002), state: 'OPEN', at: null },
    ]);
    await readGithubPrStates(urls, spawn as never);
    expect(asked.filter((item) => item === url(9001))).toHaveLength(1);
    expect(asked.filter((item) => item === url(9002))).toHaveLength(2);
    expect(asked.filter((item) => item === url(9003))).toHaveLength(1);
    expect(asked.filter((item) => item === url(9004))).toHaveLength(2);
  });
});

describe('readAskEvidence', () => {
  test('reports pull requests the ask names that merged since it opened', async () => {
    const read: string[][] = [];
    const pack = createCodingPack({
      readPrs: async () => [],
      readPrStates: async (urls) => {
        read.push([...urls]);
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
    expect(read).toEqual([[url(6159), url(6205)]]);
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
    service.readPrStates = async (urls) => states.filter((pr) => urls.includes(pr.url));
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
