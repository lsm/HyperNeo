import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke';
import {
  NEO_WORK_UNVERIFIED_REPLY_NOTE,
  readDriverFollowUp,
  readDriverCardExchange,
  readDriverSettlement,
} from '../../../../src/lib/neo/driver-work';
import { planNeoWorkFollow } from '../../../../src/lib/neo/work-follow';
import {
  keepNeoCardPrReads,
  planNeoCardPrCandidates,
  planNeoCardPrOwnership,
} from '../../../../src/lib/neo/packs/coding/card-pr-claims';
import { NeoWorkPrClaimRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-claim-repository';
import { createTestDb } from '../../../helpers/database';

const user = (at: number, text: string) => ({ at, role: 'user' as const, text });
const agent = (at: number, text: string) => ({ at, role: 'agent' as const, text });
const sent = { opening: 'Fix the font', inputBefore: 10 };
const exchange = [
  user(11, 'Fix the font'),
  agent(20, 'Font fixed'),
  user(30, 'PR event for another card'),
  agent(40, 'Other PR merged'),
];
const outcome = (entries = exchange, extra = {}): OperationOutcome => ({
  kind: 'completed',
  value: {
    ok: true,
    value: {
      status: 'done',
      lastActivityAt: 40,
      lastReply: 'Other PR merged',
      exchange: entries,
      ...extra,
    },
  },
});
const card = {
  id: 'card',
  createdAt: 1,
  updatedAt: 21,
  title: 'Fix font',
  instruction: sent.opening,
  report: 'Font fixed',
} as NeoWork;
const url = 'https://github.com/lsm/HyperNeo/pull/1';

describe('card input provenance', () => {
  test('settles only the own reply, omitting another input and its reply', () => {
    expect(readDriverSettlement(card, outcome(), 50, 11, true, sent.opening)).toEqual({
      status: 'reported',
      report: 'Agent: Font fixed',
    });
    expect(readDriverCardExchange(outcome(), sent)).toMatchObject({
      start: 11,
      end: 20,
      current: false,
    });
    expect(planNeoWorkFollow(card, { outcome: outcome() }, { since: 21, sent })).toEqual({
      reason: null,
    });
  });
  test.each([
    { entries: [] },
    { entries: [agent(40, 'Unknown reply')] },
    { entries: [user(30, 'PR event'), agent(40, 'Other reply')] },
  ])('missing own input never falls back to lastReply', ({ entries }) => {
    expect(readDriverSettlement(card, outcome(entries), 50, 11, true, sent.opening)).toBeNull();
    expect(readDriverCardExchange(outcome(entries), sent)).toBeNull();
  });
  test('absent history preserves adapter compatibility but present empty history fails closed', () => {
    const missing = outcome(undefined, { exchange: undefined });
    expect(readDriverSettlement(card, missing, 50, 11, true, sent.opening)).toEqual({
      status: 'reported',
      report: `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nOther PR merged`,
    });
    expect(readDriverSettlement(card, outcome([]), 50, 11, true, sent.opening)).toBeNull();
    expect(readDriverSettlement(card, missing, 50, null, true, sent.opening)).toBeNull();
    expect(
      readDriverSettlement(
        card,
        outcome(undefined, { exchange: undefined, lastReplyAt: 10 }),
        50,
        11,
        true,
        sent.opening
      )
    ).toBeNull();
    const other = outcome(undefined, {
      exchange: undefined,
      recentInputs: [{ at: 30, text: 'PR event' }],
    });
    expect(readDriverSettlement(card, other, 50, 11, true, sent.opening)).toBeNull();
    expect(planNeoWorkFollow(card, { outcome: other }, { since: 21, sent })).toEqual({
      reason: null,
    });
    expect(planNeoWorkFollow(card, { outcome: missing }, { since: 21, sent })).toMatchObject({
      value: expect.stringContaining('Other PR merged'),
    });
  });
  test.each(['done', 'failed', 'stopped'])(
    'labels exchange-less %s replies without preventing settlement',
    (status) => {
      const reply = outcome(undefined, {
        status,
        exchange: undefined,
        lastReplyAt: 40,
        recentInputs: [{ at: 11, text: sent.opening }],
      });
      const report = `${NEO_WORK_UNVERIFIED_REPLY_NOTE}\n\nOther PR merged`;
      expect(readDriverSettlement(card, reply, 50, 11, true, sent.opening)).toEqual({
        status: status === 'done' ? 'reported' : 'failed',
        report: status === 'done' ? report : `It ${status}. ${report}`,
      });
      expect(readDriverFollowUp(reply, 21, sent)).toBe(report);
      expect(readDriverFollowUp(reply, 40, sent)).toBeNull();
      expect(
        readDriverFollowUp(
          outcome(undefined, {
            exchange: undefined,
            recentInputs: [{ at: 30, text: 'unrelated input' }],
          }),
          21,
          sent
        )
      ).toBeNull();
    }
  );
  test('anchored follow-up remains verified and truncated missing anchors never use latest reply', () => {
    const anchored = outcome([user(11, sent.opening), agent(40, 'Own reply')]);
    expect(readDriverFollowUp(anchored, 21, sent)).toBe('Agent: Own reply');
    const truncated = outcome([agent(40, 'Unknown reply')], { exchangeCut: true });
    expect(readDriverFollowUp(truncated, 21, sent)).toBeNull();
    expect(readDriverSettlement(card, truncated, 50, 11, true, sent.opening)).toBeNull();
  });
  test('a continued or amended input establishes its own report boundary', () => {
    const continued = { inputBefore: 40, opening: 'Also fix spacing' };
    const reply = outcome([
      ...exchange,
      user(41, continued.opening),
      agent(45, 'Spacing fixed'),
      user(46, 'CI event'),
      agent(48, 'CI update'),
    ]);
    expect(readDriverCardExchange(reply, continued)?.replies).toEqual([agent(45, 'Spacing fixed')]);
    expect(
      planNeoWorkFollow(card, { outcome: reply }, { since: 40, sent: continued })
    ).toMatchObject({ value: 'Agent: Spacing fixed\n\nEarlier report:\nFont fixed' });
  });
});

describe('coding PR provenance', () => {
  const window = { start: 11, end: 20 };
  const pr = (createdAt: number) => ({
    url,
    createdAt,
    state: 'OPEN' as const,
    checks: 'pending' as const,
    review: 'none' as const,
  });
  const candidates = (
    branch = [url],
    follows: string | null = null,
    scope: typeof window | null = window
  ) =>
    planNeoCardPrCandidates({
      follows,
      branch,
      report: null,
      stored: [],
      opened: [url],
      window: scope,
    });
  test.each([10, 21, 40])('rejects an inferred PR outside the card lifetime at %s', (at) => {
    const owned = planNeoCardPrOwnership(card, candidates(), [], 50);
    expect(keepNeoCardPrReads(card, owned, [pr(at)]).rejected).toHaveLength(1);
  });
  test('requires lifetime timestamp proof without requiring the current branch', () => {
    expect(
      keepNeoCardPrReads(card, planNeoCardPrOwnership(card, candidates([]), [], 50), [pr(15)]).kept
    ).toHaveLength(1);
    expect(
      keepNeoCardPrReads(card, planNeoCardPrOwnership(card, candidates(), [], 50), [
        { ...pr(15), createdAt: undefined },
      ]).kept
    ).toEqual([]);
    expect(
      keepNeoCardPrReads(card, planNeoCardPrOwnership(card, candidates([], '', null), [], 50), [
        pr(15),
      ]).kept
    ).toEqual([]);
  });
  test('a PR the card follows remains valid outside the execution window', () => {
    const owned = planNeoCardPrOwnership(card, candidates([url], url, null), [], 50);
    expect(owned[0].claim).toBe('named');
    expect(keepNeoCardPrReads(card, owned, [pr(1)]).kept).toHaveLength(1);
  });
  test('persists verified ownership across restart and later continues, but revalidates legacy claims', async () => {
    const db = await createTestDb();
    try {
      const raw = db.getDatabase();
      raw
        .prepare(
          "INSERT INTO neo_work(id,request_key,origin_session_id,title,instruction,status,created_at,updated_at) VALUES ('card','key','root','Font','Fix font','reported',1,21)"
        )
        .run();
      const repo = new NeoWorkPrClaimRepository(raw);
      const kept = keepNeoCardPrReads(card, planNeoCardPrOwnership(card, candidates(), [], 50), [
        pr(15),
      ]).kept;
      expect(kept[0].scoped).toBe(true);
      repo.replace(card.id, kept);
      const restored = new NeoWorkPrClaimRepository(raw).forUrls([url]);
      const continued = candidates([], null, null);
      expect(
        keepNeoCardPrReads(card, planNeoCardPrOwnership(card, continued, restored, 60), []).kept
      ).toHaveLength(1);
      repo.replace(card.id, [{ url, claim: 'branch', claimedAt: 10 }]);
      expect(
        keepNeoCardPrReads(card, planNeoCardPrOwnership(card, continued, repo.forUrls([url]), 60), [
          pr(15),
        ]).kept
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
