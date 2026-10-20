import { describe, expect, test } from 'bun:test';
import { codexOpenedPrs } from '../../../../src/lib/drivers/opened-prs.ts';
import { syntheticCodexPrLines, SYNTHETIC_PR } from '../../../helpers/codex-pr-transcript.ts';

describe('Codex PR attribution latency', () => {
  test('returns only the actually attached PR without stalling on repeated unmatched tool documentation', () => {
    const lines = syntheticCodexPrLines();
    const start = performance.now();
    const result = codexOpenedPrs(lines);
    const elapsed = performance.now() - start;
    expect(result).toEqual([SYNTHETIC_PR]);
    expect(elapsed).toBeLessThan(500);
  }, 20_000);
});
