import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import {
  CODING_CHECK_ISSUE_CLOSED,
  CODING_CHECK_ISSUE_FILED,
  CODING_CHECK_ISSUE_SUB_ISSUE,
  judgeNeoIssueCheck,
  planNeoIssueChecks,
  readNeoIssueTicks,
} from '../../../../src/lib/neo/packs/coding/issue-checks.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const issueUrl = (n: number) => `https://github.com/lsm/HyperNeo/issues/${n}`;
const item = (id: string, text: string, check: string | null): NeoAskItem => ({
  id,
  text,
  state: 'pending',
  evidence: null,
  check: check as NeoAskItem['check'],
  metBy: null,
  removed: false,
  addedAt: null,
});
const ask = (items: NeoAskItem[]): NeoAsk => ({
  id: 'a1',
  requestKey: 'k1',
  projectId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Issue evidence',
  ask: 'File the issue under lsm/HyperNeo#6002 and get it merged',
  doneWhen: '',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  settledAt: null,
  workIds: [],
  doneItems: items,
});
const issue = (n: number, extra: Partial<NeoRefState> = {}): NeoRefState => ({
  url: issueUrl(n),
  kind: 'issue',
  state: 'OPEN',
  at: null,
  done: false,
  closedBy: null,
  createdAt: 2_000,
  parent: null,
  ...extra,
});

describe('planNeoIssueChecks', () => {
  test('takes the issue an item names, the epic it names last, and else one reported issue', () => {
    const plans = planNeoIssueChecks(
      ask([
        item('i1', 'lsm/HyperNeo#6591 filed', CODING_CHECK_ISSUE_FILED),
        item('i2', 'Issue linked under lsm/HyperNeo#6002', CODING_CHECK_ISSUE_SUB_ISSUE),
        item('i3', 'Merged to dev', null),
      ]),
      ['Filed lsm/HyperNeo#6591.']
    );
    expect(
      plans.map((plan) => [
        plan.item.id,
        plan.refs.map((ref) => ref.number),
        plan.epic?.number ?? null,
        plan.fallback,
      ])
    ).toEqual([
      ['i1', [6591], null, false],
      ['i2', [6591], 6002, true],
    ]);
  });
});

describe('planNeoIssueChecks with URLs', () => {
  test('reads issues and epics named by full URL, keeping the epic last', () => {
    const [plan] = planNeoIssueChecks(
      ask([
        item(
          'i1',
          `${issueUrl(6591)} linked under ${issueUrl(6002)}`,
          CODING_CHECK_ISSUE_SUB_ISSUE
        ),
      ]),
      []
    );
    expect([plan.refs.map((ref) => ref.number), plan.epic?.number, plan.fallback]).toEqual([
      [6591],
      6002,
      false,
    ]);
    const [mixed] = planNeoIssueChecks(
      ask([item('i1', `lsm/HyperNeo#6591 under ${issueUrl(6002)}`, CODING_CHECK_ISSUE_SUB_ISSUE)]),
      []
    );
    expect([mixed.refs.map((ref) => ref.number), mixed.epic?.number]).toEqual([[6591], 6002]);
  });
});

describe('judgeNeoIssueCheck', () => {
  const [filed, linked, closed] = planNeoIssueChecks(
    ask([
      item('i1', 'lsm/HyperNeo#6591 filed', CODING_CHECK_ISSUE_FILED),
      item('i2', 'lsm/HyperNeo#6591 under lsm/HyperNeo#6002', CODING_CHECK_ISSUE_SUB_ISSUE),
      item('i3', 'lsm/HyperNeo#6591 closed', CODING_CHECK_ISSUE_CLOSED),
    ]),
    []
  );

  test('ticks filed, linked and closed only from what GitHub says', () => {
    expect(judgeNeoIssueCheck(filed, [issue(6591)], 1_000)).toEqual({
      id: 'i1',
      evidence: `Filed: ${issueUrl(6591)}`,
    });
    expect(judgeNeoIssueCheck(linked, [issue(6591)], 1_000)).toBeNull();
    expect(
      judgeNeoIssueCheck(
        linked,
        [issue(6591, { parent: { url: issueUrl(6002), at: null } })],
        1_000
      )
    ).toEqual({
      id: 'i2',
      evidence: `Sub-issue of ${issueUrl(6002)}: ${issueUrl(6591)}`,
    });
    expect(
      judgeNeoIssueCheck(
        linked,
        [issue(6591, { parent: { url: issueUrl(6003), at: null } })],
        1_000
      )
    ).toBeNull();
    expect(judgeNeoIssueCheck(closed, [issue(6591, { state: 'CLOSED' })], 1_000)).toBeNull();
    expect(
      judgeNeoIssueCheck(closed, [issue(6591, { state: 'CLOSED', done: true })], 1_000)
    ).toEqual({ id: 'i3', evidence: `Closed: ${issueUrl(6591)}` });
    expect(
      judgeNeoIssueCheck(filed, [{ ...issue(6591), kind: 'pr', url: issueUrl(6591) }], 1_000)
    ).toBeNull();
  });

  test('a reported issue counts only when it is the one new issue the cards name', () => {
    const [fallback] = planNeoIssueChecks(
      ask([item('i1', 'Issue filed for issue evidence', CODING_CHECK_ISSUE_FILED)]),
      [`Filed ${issueUrl(6591)}; see also lsm/HyperNeo#6500.`]
    );
    expect(
      judgeNeoIssueCheck(fallback, [issue(6591), issue(6500, { createdAt: 500 })], 1_000)
    ).toEqual({
      id: 'i1',
      evidence: `Filed: ${issueUrl(6591)}`,
    });
    expect(judgeNeoIssueCheck(fallback, [issue(6591), issue(6500)], 1_000)).toBeNull();
  });
});

describe('readNeoIssueTicks', () => {
  test('reads only asks with open issue items, at most every two minutes', async () => {
    const reads: number[][] = [];
    const read = async (refs: readonly { number: number }[]) => {
      reads.push(refs.map((ref) => ref.number));
      return [issue(6591)];
    };
    const plain = { ...ask([item('i1', 'Merged to dev', null)]), id: 'plain' };
    expect(await readNeoIssueTicks(plain, [], read, 10_000)).toEqual([]);
    const filed = {
      ...ask([item('i1', 'lsm/HyperNeo#6591 filed', CODING_CHECK_ISSUE_FILED)]),
      id: 'filed',
    };
    expect(await readNeoIssueTicks(filed, [], read, 10_000)).toEqual([
      { id: 'i1', evidence: `Filed: ${issueUrl(6591)}` },
    ]);
    expect(await readNeoIssueTicks(filed, [], read, 60_000)).toEqual([]);
    expect(
      await readNeoIssueTicks(filed, [{ report: null } as NeoWork], read, 130_001)
    ).toHaveLength(1);
    expect(reads).toEqual([[6591], [6591]]);
  });
});

describe('refreshDriverWork issue ticks', () => {
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

  test('ticks a linked-under-epic item met by the daemon from the issue parent', async () => {
    const opened = service.askRecords.open(
      {
        id: 'a-issue',
        requestKey: 'k-issue',
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: 'm0',
        title: 'Issue evidence',
        ask: 'File it under lsm/HyperNeo#6002',
        doneWhen: '- lsm/HyperNeo#6591 linked under lsm/HyperNeo#6002\n- merged',
        doneSource: 'human',
      },
      [
        {
          text: 'lsm/HyperNeo#6591 linked under lsm/HyperNeo#6002',
          check: CODING_CHECK_ISSUE_SUB_ISSUE,
        },
        { text: 'merged', check: null },
      ]
    )!;
    service.readRefStates = async () => [
      issue(6591, { parent: { url: issueUrl(6002), at: null } }),
    ];
    Object.assign(service, { deliver: async () => {} });
    await service.refreshDriverWork();
    expect(service.askRecords.get(opened.id)?.doneItems?.[0]).toMatchObject({
      state: 'met',
      metBy: 'daemon',
      evidence: `Sub-issue of ${issueUrl(6002)}: ${issueUrl(6591)}`,
    });
  });
});
