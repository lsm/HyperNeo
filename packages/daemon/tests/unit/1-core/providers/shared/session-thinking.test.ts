import { describe, expect, it } from 'bun:test';
import { sessionThinkingForLevel } from '../../../../../src/lib/providers/shared/session-thinking';

describe('sessionThinkingForLevel', () => {
  it('turns Off into an explicit disabled block so bridges send their off effort', () => {
    expect(sessionThinkingForLevel('off')).toEqual({ type: 'disabled' });
  });

  it('turns a level into its token budget', () => {
    expect(sessionThinkingForLevel('think16k')).toEqual({ type: 'enabled', budget_tokens: 16000 });
  });

  it('leaves the request alone when no level is known', () => {
    expect(sessionThinkingForLevel(undefined)).toBeUndefined();
  });
});
