import { describe, expect, test } from 'bun:test';
import { recentWorkInputs } from '../../../../src/lib/drivers/work-messages';

const inputs = Array.from({ length: 60 }, (_, index) => ({
  at: index * 10,
  text: `input ${index}`,
}));

describe('recentWorkInputs', () => {
  test('keeps the latest eight inputs without a cutoff', () => {
    expect(recentWorkInputs(inputs).map((input) => input.at)).toEqual([
      520, 530, 540, 550, 560, 570, 580, 590,
    ]);
  });

  test('keeps the earliest inputs after a cutoff, so a message sent then is still found', () => {
    const after = recentWorkInputs(inputs, 95);
    expect(after[0]).toEqual({ at: 100, text: 'input 10' });
    expect(after).toHaveLength(50);
  });
});
