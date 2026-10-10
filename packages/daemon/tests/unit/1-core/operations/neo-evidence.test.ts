import { describe, expect, test } from 'bun:test';
import {
  type NeoEvidence,
  type NeoEvidenceTold,
  neoEvidenceSignature,
  planNeoDoneCheck,
} from '../../../../src/lib/neo/evidence.ts';

const open: NeoEvidence = { key: 'pr/2', state: 'pending', summary: 'open', blockers: [] };
const ready: NeoEvidence = { ...open, state: 'ready', summary: 'approved' };
const halfHour = 30 * 60_000;

describe('neoEvidenceSignature', () => {
  test('ignores the order evidence was read in', () => {
    const other: NeoEvidence = { ...open, key: 'pr/1' };
    expect(neoEvidenceSignature([open, other])).toBe(neoEvidenceSignature([other, open]));
  });

  test.each<[string, Partial<NeoEvidence>]>([
    ['state', { state: 'failed' }],
    ['summary', { summary: 'open, checks failing' }],
    ['blockers', { blockers: ['behind dev'] }],
  ])('changes with the %s', (_label, change) => {
    expect(neoEvidenceSignature([{ ...open, ...change }])).not.toBe(neoEvidenceSignature([open]));
  });
});

describe('planNeoDoneCheck', () => {
  const told = (evidence: NeoEvidence[]): NeoEvidenceTold => ({
    signature: neoEvidenceSignature(evidence),
    toldAt: 0,
    reminded: null,
  });
  const quiet = { quietSince: 0, remindable: true };

  test.each<
    [
      string,
      NeoEvidence[],
      NeoEvidenceTold | null,
      { ok: boolean; okAt: number },
      number,
      ReturnType<typeof planNeoDoneCheck>,
    ]
  >([
    [
      'evidence still settling',
      [{ ...open, state: 'waiting' }],
      null,
      { ok: true, okAt: 0 },
      0,
      'wait',
    ],
    ['evidence Neo has not seen', [open], null, { ok: true, okAt: 0 }, 0, 'deliver'],
    ['the evidence Neo already saw', [open], told([open]), { ok: true, okAt: 0 }, 0, 'unchanged'],
    ['changed evidence', [ready], told([open]), { ok: true, okAt: 0 }, 0, 'deliver'],
    [
      'a failed read soon after a good one',
      [open],
      null,
      { ok: false, okAt: 0 },
      halfHour - 1,
      'wait',
    ],
    ['reads failing for half an hour', [open], null, { ok: false, okAt: 0 }, halfHour, 'deliver'],
    [
      'reads still failing after Neo was told',
      [open],
      told([open]),
      { ok: false, okAt: 0 },
      halfHour,
      'wait',
    ],
  ])('%s', (_label, evidence, before, read, now, plan) => {
    expect(planNeoDoneCheck(evidence, before, read, now, quiet)).toBe(plan);
  });

  const now = 10 * halfHour;
  const seen = { ...told([ready]), toldAt: now - halfHour };
  test.each<
    [
      string,
      NeoEvidence[],
      NeoEvidenceTold,
      Parameters<typeof planNeoDoneCheck>[4],
      ReturnType<typeof planNeoDoneCheck>,
    ]
  >([
    [
      'ready evidence left alone for half an hour',
      [ready],
      seen,
      { ...quiet, quietSince: now - halfHour },
      'remind',
    ],
    [
      'one Neo was told about a minute ago',
      [ready],
      { ...seen, toldAt: now - 60_000 },
      quiet,
      'unchanged',
    ],
    [
      'one whose session moved since',
      [ready],
      seen,
      { ...quiet, quietSince: now - 60_000 },
      'unchanged',
    ],
    [
      'one already reminded in this state',
      [ready],
      { ...seen, reminded: seen.signature },
      quiet,
      'unchanged',
    ],
    [
      'one under an ask that is settled or waits on the human',
      [ready],
      seen,
      { ...quiet, remindable: false },
      'unchanged',
    ],
    [
      'one told before delivery times were kept',
      [ready],
      { ...seen, toldAt: null },
      quiet,
      'remind',
    ],
    ['one still waiting for review', [open], told([open]), quiet, 'unchanged'],
  ])('%s', (_label, evidence, before, card, plan) => {
    expect(planNeoDoneCheck(evidence, before, { ok: true, okAt: now }, now, card)).toBe(plan);
  });
});
