import { describe, expect, test } from 'bun:test';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke';
import { readDriverCardExchange, readDriverSettlement } from '../../../../src/lib/neo/driver-work';
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
  const candidates = (branch = [url], brief = '', scope: typeof window | null = window) =>
    planNeoCardPrCandidates({
      brief,
      branch,
      report: url,
      stored: [],
      opened: [url],
      window: scope,
    });
  test.each([10, 21, 40])('rejects a same-branch PR outside the card exchange at %s', (at) => {
    const owned = planNeoCardPrOwnership(card, candidates(), [], 50);
    expect(keepNeoCardPrReads(card, owned, [pr(at)]).rejected).toHaveLength(1);
  });
  test('requires branch and timestamp proof even for report mentions or session-opened PRs', () => {
    expect(
      keepNeoCardPrReads(card, planNeoCardPrOwnership(card, candidates([]), [], 50), [pr(15)]).kept
    ).toEqual([]);
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
  test('a PR explicitly named by the brief remains valid outside the execution window', () => {
    const owned = planNeoCardPrOwnership(card, candidates([url], `Review ${url}`, null), [], 50);
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
      const continued = candidates([], '', null);
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
