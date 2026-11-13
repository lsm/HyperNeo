import { describe, expect, it } from 'vitest';
import { stoppedErrorCardUuid } from '../stopped-error-card.ts';

const episode = {
  id: 'e',
  failures: 3,
  retryAt: 0,
  error: '{"type":"result","uuid":"r1","is_error":true}',
  failed: true,
};
const user = { type: 'user', uuid: 'u1' };
const card = { type: 'assistant', uuid: 'a1', error: 'server_error' };
const result = { type: 'result', uuid: 'r1' };

describe('stoppedErrorCardUuid', () => {
  it('picks the API Error card that ended the stopped turn', () => {
    expect(stoppedErrorCardUuid([user, card, result], episode)).toBe('a1');
  });

  it('keeps the banner when the turn ended without an API Error card', () => {
    expect(
      stoppedErrorCardUuid([user, { type: 'assistant', uuid: 'a2' }, result], episode)
    ).toBeUndefined();
    expect(stoppedErrorCardUuid([card, user, { ...result, uuid: 'r2' }], episode)).toBeUndefined();
  });

  it('does not move a stale stop onto a later failure card', () => {
    const later = [
      user,
      card,
      result,
      { type: 'user', uuid: 'u2' },
      { type: 'assistant', uuid: 'a2', error: 'server_error' },
      { type: 'result', uuid: 'r2' },
    ];
    expect(stoppedErrorCardUuid(later, episode)).toBeUndefined();
    expect(stoppedErrorCardUuid(later.slice(0, 4), episode)).toBeUndefined();
  });

  it('keeps the banner for errors that are not a stopped failure episode', () => {
    expect(stoppedErrorCardUuid([user, card, result], undefined)).toBeUndefined();
    expect(
      stoppedErrorCardUuid([user, card, result], { ...episode, failed: false })
    ).toBeUndefined();
    expect(
      stoppedErrorCardUuid([user, card, result], { ...episode, error: 'Query timed out' })
    ).toBeUndefined();
  });

  it('still picks the card when the stored result JSON was cut before its uuid', () => {
    const failed = {
      type: 'result',
      duration_api_ms: 1200,
      is_error: true,
      result: 'x'.repeat(5000),
      uuid: 'r1',
    };
    const cut = JSON.stringify(failed).slice(0, 4096);
    expect(stoppedErrorCardUuid([user, card, failed], { ...episode, error: cut })).toBe('a1');
    const later = [
      user,
      card,
      failed,
      { type: 'user', uuid: 'u2' },
      { type: 'assistant', uuid: 'a2', error: 'server_error' },
      { ...failed, duration_api_ms: 900, uuid: 'r2' },
    ];
    expect(stoppedErrorCardUuid(later, { ...episode, error: cut })).toBeUndefined();
  });
});
