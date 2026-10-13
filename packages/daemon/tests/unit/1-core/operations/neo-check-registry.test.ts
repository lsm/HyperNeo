import { describe, expect, test } from 'bun:test';
import { buildNeoCheckRegistry } from '../../../../src/lib/neo/packs/check-registry';
import type { NeoPack } from '../../../../src/lib/neo/packs/types';

const confirmed = () => ({ value: 'confirmed' });
const pack = (id: string): NeoPack => ({
  id,
  describe: id,
  instructions: () => null,
  checks: { [`${id}.confirmed`]: confirmed },
});

describe('buildNeoCheckRegistry', () => {
  test('discovers loaded pack kinds with conservative evidence metadata', () => {
    const legal = pack('legal');
    legal.checkEvidence = { 'legal.confirmed': { independent: true } };
    const registry = buildNeoCheckRegistry([pack('life-admin'), legal]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) throw new Error(registry.reason);
    expect(registry.kinds).toEqual(['legal.confirmed', 'life-admin.confirmed']);
    expect(registry.resolve('life-admin.confirmed')).toEqual({
      ok: true,
      value: { packId: 'life-admin', check: confirmed, independent: false },
    });
    expect(registry.resolve('legal.confirmed')).toEqual({
      ok: true,
      value: { packId: 'legal', check: confirmed, independent: true },
    });
    expect(registry.resolve('coding.pr_merged')).toEqual({
      ok: false,
      reason: 'unsupported_check: coding.pr_merged',
    });
  });
  test('unloading or changing a pack never reuses old independence metadata', () => {
    const source = pack('legal');
    source.checkEvidence = { 'legal.confirmed': { independent: true } };
    const first = buildNeoCheckRegistry([source]);
    source.checkEvidence['legal.confirmed'].independent = false;
    const second = buildNeoCheckRegistry([source]);
    const absent = buildNeoCheckRegistry([]);
    if (!first.ok || !second.ok || !absent.ok) throw new Error('registry refused');
    expect(first.resolve('legal.confirmed')).toMatchObject({ value: { independent: true } });
    expect(second.resolve('legal.confirmed')).toMatchObject({ value: { independent: false } });
    expect(absent.resolve('legal.confirmed').ok).toBe(false);
  });
  test('duplicate packs refuse instead of silently overwriting a check', () => {
    expect(buildNeoCheckRegistry([pack('legal'), pack('legal')])).toEqual({
      ok: false,
      reason: 'duplicate_pack: legal',
    });
  });
  test('kinds must belong to the declaring pack', () => {
    for (const kind of ['coding.pr_merged', '__proto__', 'legal.', 'legal.bad kind']) {
      expect(buildNeoCheckRegistry([{ ...pack('legal'), checks: { [kind]: confirmed } }])).toEqual({
        ok: false,
        reason: `invalid_check_kind: ${kind}`,
      });
    }
  });
  test('metadata cannot register a check without an evaluator', () => {
    expect(
      buildNeoCheckRegistry([
        { ...pack('legal'), checkEvidence: { 'legal.missing': { independent: true } } },
      ])
    ).toEqual({ ok: false, reason: 'unregistered_check_metadata: legal.missing' });
  });
});
