import { describe, expect, test } from 'bun:test';
import {
  type CodingTurn,
  planCodingTurnFacts,
  planCodingTurnOwner,
} from '../../../../src/lib/neo/packs/coding/turn-owner.ts';

const url = 'https://github.com/acme/app/pull/7';
const session = { adapter: 'hyperneo', id: 's1' };
const turn = (change: Partial<CodingTurn> = {}): CodingTurn => ({
  ref: session,
  id: 't1',
  startedAt: 100,
  endedAt: 200,
  ended: 'success',
  inputs: ['receipt-a'],
  urls: [url],
  finalUrls: [url],
  complete: true,
  cursor: '{}',
  previous: null,
  ...change,
});
const todos = { 'receipt-a': 'todo-a', 'receipt-b': 'todo-b' };
const owner = (turns: CodingTurn[], createdAt: number | undefined = 150) =>
  planCodingTurnOwner({ url, createdAt }, turns, todos);

describe('coding turn ownership', () => {
  test('a PR belongs to the turn that shows it while GitHub created it', () => {
    expect(owner([turn()])).toEqual({ state: 'placed', session, todo: 'todo-a' });
  });

  test('both ends of the turn count', () => {
    expect(owner([turn()], 100).state).toBe('placed');
    expect(owner([turn()], 200).state).toBe('placed');
  });

  test('a mention outside the turn is nothing', () => {
    expect(owner([turn()], 201)).toEqual({ state: 'none' });
    expect(owner([turn()], 99)).toEqual({ state: 'none' });
  });

  test('matches other forms of the same PR URL only', () => {
    expect(owner([turn({ urls: [`${url}/files`] })]).state).toBe('placed');
    expect(owner([turn({ urls: [`${url}3`] })])).toEqual({ state: 'none' });
    expect(owner([turn({ urls: [url.replace('acme', 'ACME')] })]).state).toBe('placed');
  });

  test('the turn that reports a PR owns it, not a turn that only displayed it', () => {
    const other = { adapter: 'hyperneo', id: 's2' };
    const shown = turn({ ref: other, inputs: ['receipt-b'], finalUrls: [] });
    expect(owner([shown, turn()])).toEqual({ state: 'placed', session, todo: 'todo-a' });
  });

  test('two sessions reporting one PR stay unknown', () => {
    const other = { adapter: 'hyperneo', id: 's2' };
    expect(owner([turn(), turn({ ref: other })])).toEqual({ state: 'unknown' });
  });

  test('a PR only in tool output is placed when nothing else could claim it', () => {
    expect(owner([turn({ finalUrls: [] })])).toEqual({ state: 'placed', session, todo: 'todo-a' });
    expect(owner([turn({ finalUrls: ['https://example.com/report'] })]).state).toBe('placed');
  });

  test('a PR only in tool output is unknown beside a reported PR or a second turn', () => {
    const other = 'https://github.com/acme/app/pull/8';
    expect(owner([turn({ urls: [url, other], finalUrls: [other] })])).toEqual({ state: 'unknown' });
    const shown = turn({ finalUrls: [] });
    expect(owner([shown, { ...shown, id: 't2' }])).toEqual({ state: 'unknown' });
  });

  test('a turn with no recorded todo still names the session', () => {
    expect(owner([turn({ inputs: [] })])).toEqual({ state: 'placed', session, todo: null });
    expect(owner([turn({ inputs: ['typed-by-a-person'] })])).toEqual({
      state: 'placed',
      session,
      todo: null,
    });
  });

  test('a turn shared by several todos names only the session', () => {
    expect(owner([turn({ inputs: ['receipt-a', 'receipt-b'] })])).toEqual({
      state: 'placed',
      session,
      todo: null,
    });
  });

  test('a row id and a pending id for one input count as one todo', () => {
    const both = { ...todos, 'desktop-pending:hash': 'todo-a' };
    const pending = turn({ inputs: ['receipt-a', 'desktop-pending:hash'] });
    expect(planCodingTurnOwner({ url, createdAt: 150 }, [pending], both)).toEqual({
      state: 'placed',
      session,
      todo: 'todo-a',
    });
  });

  test('a Codex send owns the turn by its native turn id', () => {
    expect(
      planCodingTurnOwner({ url, createdAt: 150 }, [turn({ inputs: [] })], { t1: 'todo-b' })
    ).toEqual({ state: 'placed', session, todo: 'todo-b' });
  });

  test.each(['aborted', 'interrupted'])('an inputless turn continues a turn %s', (ended) => {
    const previous = { ended, id: 'p', inputs: ['receipt-b'] };
    expect(owner([turn({ inputs: [], previous })]).state).toBe('placed');
    expect(owner([turn({ inputs: [], previous })])).toMatchObject({ todo: 'todo-b' });
  });

  test('an inputless turn continues the aborted turn before it', () => {
    const previous = { ended: 'aborted', id: 'p', inputs: ['receipt-b'] };
    expect(owner([turn({ inputs: [], previous })])).toEqual({
      state: 'placed',
      session,
      todo: 'todo-b',
    });
  });

  test('an inputless turn after a finished turn has no todo', () => {
    const previous = { ended: 'success', id: 'p', inputs: ['receipt-b'] };
    expect(owner([turn({ inputs: [], previous })])).toEqual({
      state: 'placed',
      session,
      todo: null,
    });
  });

  test('an unread turn stays unknown, never no PR', () => {
    expect(owner([turn({ complete: false })])).toEqual({ state: 'unknown' });
    expect(planCodingTurnOwner({ url }, [turn()], todos)).toEqual({ state: 'unknown' });
  });

  test('two sessions in the window stay unknown', () => {
    expect(owner([turn(), turn({ ref: { adapter: 'codex', id: 's2' }, id: 't2' })])).toEqual({
      state: 'unknown',
    });
  });

  test('the same session keeps the turn holding the creation', () => {
    const early = turn({ id: 't0', startedAt: 1, endedAt: 50, inputs: ['receipt-b'] });
    expect(owner([early, turn()])).toEqual({ state: 'placed', session, todo: 'todo-a' });
  });
});

describe('planCodingTurnFacts', () => {
  const todo = { id: 'todo-a', check: { pack: 'coding', kind: 'pr_merged', params: {} } };
  const pr = { url, state: 'MERGED', createdAt: 150 } as never;
  const mentions = { turns: [turn()], todos };

  test('keeps the PRs this todo produced', () => {
    expect(planCodingTurnFacts(todo, [turn()], [url], [pr], mentions, 9)).toEqual({
      prs: [pr],
      observedAt: 9,
    });
  });

  test('drops a PR another todo produced in the same session', () => {
    const other = { turns: [turn({ inputs: ['receipt-b'] })], todos };
    expect(planCodingTurnFacts(todo, [turn()], [url], [pr], other, 9).prs).toEqual([]);
  });

  test('keeps a PR named in the check whoever produced it', () => {
    const named = { ...todo, check: { ...todo.check, params: { urls: [url] } } };
    expect(planCodingTurnFacts(named, [], [url], [pr], { turns: [], todos: {} }, 9).prs).toEqual([
      pr,
    ]);
  });

  test('stays incomplete when a turn, a read or an owner is unknown', () => {
    const facts = (own: CodingTurn[], read: never[] | null, seen = mentions) =>
      planCodingTurnFacts(todo, own, [url], read, seen, 9);
    expect(facts([turn({ complete: false })], [pr]).incomplete).toBe(true);
    expect(facts([turn()], null).incomplete).toBe(true);
    expect(facts([turn()], []).incomplete).toBe(true);
    expect(facts([turn()], [pr], { turns: [turn({ complete: false })], todos }).incomplete).toBe(
      true
    );
  });
});
