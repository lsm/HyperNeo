import { describe, expect, test } from 'bun:test';
import { parseProcessingState } from '../../../../src/lib/session/space-session-reads.ts';

describe('parseProcessingState', () => {
  test('leaves out a network pause held prompt', () => {
    const state = parseProcessingState(
      JSON.stringify({
        status: 'rate_limit_cooldown',
        reason: 'network',
        messageId: 'held-uuid',
        heldPrompt: { uuid: 'held-uuid', content: 'ship it' },
      })
    );

    expect(state).toEqual({
      status: 'rate_limit_cooldown',
      reason: 'network',
      messageId: 'held-uuid',
    });
  });

  test('falls back to the raw status for a non-object value', () => {
    expect(parseProcessingState(null)).toEqual({ status: 'idle' });
  });
});
