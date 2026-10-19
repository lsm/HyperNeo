import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoCardPrFacts } from '../../../../src/lib/neo/packs/coding/card-facts.ts';

const url = 'https://github.com/lsm/HyperNeo/pull/1';
const pr = (fields: Partial<NeoWorkPr> = {}): NeoWorkPr => ({
  url,
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
  ...fields,
});

describe('neoCardPrFacts', () => {
  test('states the live or stale PR read, with no command in it', () => {
    const live = neoCardPrFacts([pr({ blockers: ['behind dev'] })], false);
    expect(live?.data).toEqual({
      waiting_on_pr: [],
      prs: [{ url, state: 'OPEN', checks: 'passing', review: 'none', blockers: ['behind dev'] }],
    });
    expect(live?.text).toContain('live state');
    expect(neoCardPrFacts([pr()], true)?.text).toContain('may be out of date');
    expect(neoCardPrFacts(undefined, false)).toBeNull();
    expect(neoCardPrFacts([pr({ checks: 'pending' })], false)?.data?.waiting_on_pr).toEqual([url]);
  });

  test('names a pull request that can be merged now, and only that one', () => {
    const ready = pr({ review: 'approved' });
    const facts = neoCardPrFacts(
      [
        ready,
        pr({ url: `${url}0`, review: 'approved', blockers: ['behind dev'] }),
        pr({ url: `${url}1` }),
      ],
      false
    );
    expect(facts?.text).toContain(`so it can be merged now: ${url}.`);
    expect(facts?.text).not.toContain(`${url}0`);
    expect(facts?.text).not.toContain(`${url}1`);
    expect(
      neoCardPrFacts([pr({ checks: 'pending', review: 'approved' })], false)?.text
    ).not.toContain('merged now');
    expect(neoCardPrFacts([ready], true)?.text).not.toContain('merged now');
  });
});
