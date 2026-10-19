import { describe, expect, test } from 'bun:test';
import { neoHumanTurnOrigin } from '../../../../src/lib/neo/notification-triggers.ts';

describe('neoHumanTurnOrigin', () => {
  const human = (id: string) => id === 'm1';

  test('a turn acts for the human message it answers, the one its own continuation carries, or the one the human’s answer carries', () => {
    expect(neoHumanTurnOrigin('m1', 'human:m1', human)).toBe('m1');
    expect(neoHumanTurnOrigin('neo-turn-limit:human:r1', 'human:m1', human)).toBe('m1');
    expect(neoHumanTurnOrigin('neo-ask-answer:a1:i2:1', 'human:m1', human)).toBe('m1');
  });

  test('a nudge, a plain continuation or a note acts for no human message', () => {
    expect(neoHumanTurnOrigin('neo-nudge:m1', 'human:m1', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-ask-ticked:a1:i2:1', 'human:m1', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-turn-limit:r1', 'human:m1', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-turn-limit:human:r1', 'idle:a1:x', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-turn-limit:human:r1', 'human:m9', human)).toBeNull();
  });
});
