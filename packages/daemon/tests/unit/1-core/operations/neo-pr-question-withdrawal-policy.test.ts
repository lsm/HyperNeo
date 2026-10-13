import { describe, expect, test } from 'bun:test';
import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs';
import { neoPrQuestionWithdrawalPolicy as policy } from '../../../../src/lib/neo/packs/coding/question-withdrawal-policy';

const item = (change: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id: 'question',
  text: 'lsm/HyperNeo#42 CI is running; wait or continue?',
  state: 'needs_you',
  check: null,
  evidence: null,
  metBy: null,
  removed: false,
  addedAt: null,
  ...change,
});
const state = (change: Partial<NeoRefState> = {}): NeoRefState => ({
  url: 'https://github.com/lsm/HyperNeo/pull/42',
  kind: 'pr',
  state: 'MERGED',
  at: 100,
  done: true,
  closedBy: null,
  ...change,
});

describe('neoPrQuestionWithdrawalPolicy', () => {
  test.each(['MERGED', 'CLOSED'] as const)(
    'plans withdrawal on %s without a completion tick',
    (status) => {
      expect(policy.plan([item()], [state({ state: status, done: status === 'MERGED' })])).toEqual([
        {
          id: 'question',
          evidence: `Question obsolete: https://github.com/lsm/HyperNeo/pull/42 ${status === 'MERGED' ? 'merged' : 'closed unmerged'}.`,
        },
      ]);
    }
  );
  test.each(['pending', 'met', 'reported'] as const)('preserves %s outcomes', (status) => {
    expect(policy.plan([item({ state: status })], [state()])).toEqual([]);
    expect(policy.refs([item({ state: status })])).toEqual([]);
  });
  test('ignores removed questions and missing references', () => {
    expect(
      policy.plan([item({ removed: true }), item({ text: 'Confirm the design?' })], [state()])
    ).toEqual([]);
    expect(policy.plan([item()], [])).toEqual([]);
  });
  test.each([
    state({ state: 'OPEN' }),
    state({ kind: 'issue', state: 'CLOSED' }),
    state({ url: 'https://github.com/other/repo/pull/42' }),
    state({ url: 'https://other.example/lsm/HyperNeo/pull/42' }),
  ])('requires terminal PR evidence for the exact identity: %j', (evidence) => {
    expect(policy.plan([item()], [evidence])).toEqual([]);
  });
  test('requires every named reference to be terminal', () => {
    const question = item({ text: 'Wait for lsm/HyperNeo#42 and lsm/HyperNeo#43?' });
    expect(policy.plan([question], [state()])).toEqual([]);
    expect(
      policy.plan(
        [question],
        [state(), state({ url: 'https://github.com/lsm/HyperNeo/pull/43', state: 'OPEN' })]
      )
    ).toEqual([]);
    expect(
      policy.plan(
        [question],
        [state(), state({ url: 'https://github.com/lsm/HyperNeo/pull/43', state: 'CLOSED' })]
      )
    ).toHaveLength(1);
  });
  test('deduplicates names, URLs and watches without mutating evidence', () => {
    const question = Object.freeze(
      item({
        question: 'Wait for https://github.com/LSM/hyperneo/pull/42?',
        watch: ['https://github.com/lsm/HyperNeo/pull/42'],
      })
    );
    const evidence = Object.freeze([Object.freeze(state())]);
    expect(policy.refs([question])).toHaveLength(1);
    expect(policy.plan(Object.freeze([question]), evidence)).toHaveLength(1);
    expect(question.state).toBe('needs_you');
  });
  test('preserves questions with contradictory state observations', () => {
    expect(policy.plan([item()], [state(), state({ state: 'OPEN' })])).toEqual([]);
    expect(policy.plan([item()], [state(), state({ state: 'CLOSED' })])).toEqual([]);
    expect(policy.plan([item()], [state(), state()])).toHaveLength(1);
  });
  test('resolves a bare reference only with an unambiguous local repository context', () => {
    expect(policy.refs([item({ text: 'Wait for #42?' })])).toEqual([]);
    expect(policy.refs([item({ text: 'Wait for lsm/HyperNeo#42, other/repo#7 and #8?' })])).toEqual(
      []
    );
    expect(policy.refs([item({ text: 'Wait for #43 after lsm/HyperNeo#42?' })])).toEqual([
      { owner: 'lsm', repo: 'HyperNeo', number: 42 },
      { owner: 'lsm', repo: 'HyperNeo', number: 43 },
    ]);
  });
  test('does not withdraw when the shared parser may have truncated references', () => {
    const question = item({
      text: Array.from({ length: 11 }, (_, n) => `lsm/HyperNeo#${n + 1}`).join(' '),
    });
    const evidence = Array.from({ length: 10 }, (_, n) =>
      state({ url: `https://github.com/lsm/HyperNeo/pull/${n + 1}` })
    );
    expect(policy.refs([question])).toEqual([]);
    expect(policy.plan([question], evidence)).toEqual([]);
  });
});
