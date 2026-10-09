import type { NeoWorkPr, NeoWorkPrReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { describe, expect, it } from 'vitest';
import { neoWorkPrInProgress, neoWorkPrLabel, neoWorkPrSetback } from '../work-prs.ts';

const pr = (n: number, change: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url: `https://github.com/lsm/HyperNeo/pull/${n}`,
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...change,
});
const receipt = (...prs: NeoWorkPr[]): NeoWorkPrReceipt => ({ workId: 'w', prs, waiting: false });

describe('neoWorkPrLabel', () => {
  it('names the PR that still needs something, else the merged one', () => {
    const rows: [NeoWorkPrReceipt | undefined, string | null][] = [
      [undefined, null],
      [receipt(), null],
      [receipt(pr(1, { checks: 'pending' })), 'Waiting on CI · #1'],
      [receipt(pr(1)), 'Waiting on review · #1'],
      [receipt(pr(1, { review: 'approved' })), 'Approved, not merged · #1'],
      [receipt(pr(1, { checks: 'failing', review: 'approved' })), 'Checks failing · #1'],
      [receipt(pr(1, { review: 'changes_requested' })), 'Changes requested · #1'],
      [receipt(pr(1, { state: 'MERGED' })), 'Merged · #1'],
      [receipt(pr(1, { state: 'CLOSED' })), 'PR closed · #1'],
      [receipt(pr(1, { state: 'MERGED' }), pr(2, { checks: 'pending' })), 'Waiting on CI · #2 +1'],
      [
        receipt(pr(1, { checks: 'pending' }), pr(2, { checks: 'failing' })),
        'Checks failing · #2 +1',
      ],
    ];
    expect(rows.map(([input]) => neoWorkPrLabel(input))).toEqual(rows.map(([, label]) => label));
  });
});

describe('neoWorkPrInProgress', () => {
  it('holds a card while an open PR moves and lets it settle once merged, closed or stuck', () => {
    const rows: [NeoWorkPrReceipt | undefined, boolean][] = [
      [undefined, false],
      [receipt(), false],
      [receipt(pr(1, { checks: 'pending' })), true],
      [receipt(pr(1, { review: 'approved' })), true],
      [receipt(pr(1, { state: 'MERGED' })), false],
      [receipt(pr(1, { state: 'CLOSED' })), false],
      [receipt(pr(1, { checks: 'failing' })), false],
      [receipt(pr(1, { review: 'changes_requested' })), false],
      [receipt(pr(1, { state: 'MERGED' }), pr(2)), true],
    ];
    expect(rows.map(([input]) => neoWorkPrInProgress(input))).toEqual(rows.map(([, v]) => v));
  });
});

describe('neoWorkPrSetback', () => {
  it('flags failing checks, requested changes and closed PRs, not merged or moving ones', () => {
    const rows: [NeoWorkPrReceipt | undefined, boolean][] = [
      [undefined, false],
      [receipt(pr(1, { state: 'MERGED' })), false],
      [receipt(pr(1, { checks: 'pending' })), false],
      [receipt(pr(1, { checks: 'failing' })), true],
      [receipt(pr(1, { review: 'changes_requested' })), true],
      [receipt(pr(1, { state: 'CLOSED' })), true],
      [receipt(pr(1, { state: 'MERGED' }), pr(2, { state: 'CLOSED' })), true],
    ];
    expect(rows.map(([input]) => neoWorkPrSetback(input))).toEqual(rows.map(([, v]) => v));
  });
});
