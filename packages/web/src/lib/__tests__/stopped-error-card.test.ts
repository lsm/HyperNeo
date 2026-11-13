import { describe, expect, it } from 'vitest';
import { stoppedErrorCardUuid } from '../stopped-error-card.ts';

const episode = { id: 'e', failures: 3, retryAt: 0, error: '{"status":529}', failed: true };
const user = { type: 'user', uuid: 'u1' };
const card = { type: 'assistant', uuid: 'a1', error: 'server_error' };

describe('stoppedErrorCardUuid', () => {
  it('picks the API Error card that ended the stopped turn', () => {
    expect(stoppedErrorCardUuid([user, card, { type: 'result', uuid: 'r1' }], episode)).toBe('a1');
  });

  it('keeps the banner when the turn ended without an API Error card', () => {
    expect(
      stoppedErrorCardUuid([user, { type: 'assistant', uuid: 'a2' }], episode)
    ).toBeUndefined();
    expect(stoppedErrorCardUuid([card, user], episode)).toBeUndefined();
  });

  it('keeps the banner for errors that are not a stopped failure episode', () => {
    expect(stoppedErrorCardUuid([user, card], undefined)).toBeUndefined();
    expect(stoppedErrorCardUuid([user, card], { ...episode, failed: false })).toBeUndefined();
  });
});
