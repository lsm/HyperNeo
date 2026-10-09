import { describe, expect, it } from 'vitest';
import {
  decideConnectionWake,
  type ConnectionWakeAction,
  type ConnectionWakeEvent,
  type ConnectionWakeState,
} from '../connection-wake';

const live: ConnectionWakeState = {
  hidden: false,
  reachable: true,
  hasTransport: true,
  suspended: false,
  ready: true,
  resumeWaiting: false,
};

describe('decideConnectionWake', () => {
  it.each<[string, ConnectionWakeEvent, Partial<ConnectionWakeState>, ConnectionWakeAction]>([
    ['hiding schedules a suspend', 'hidden', {}, 'schedule_suspend'],
    ['a still-hidden page suspends', 'hidden_settled', { hidden: true }, 'suspend'],
    ['a page shown again before the grace keeps its socket', 'hidden_settled', {}, 'none'],
    ['showing a suspended page resumes it', 'visible', { suspended: true }, 'resume'],
    [
      'showing a suspended page offline waits',
      'visible',
      { suspended: true, reachable: false },
      'none',
    ],
    ['showing a page mid-resume waits for it', 'visible', { resumeWaiting: true }, 'none'],
    ['showing a live page validates it', 'visible', {}, 'validate'],
    ['pageshow resumes a suspended page', 'pageshow', { suspended: true }, 'resume'],
    ['pageshow leaves a hidden page', 'pageshow', { suspended: true, hidden: true }, 'none'],
    ['pageshow leaves a live page', 'pageshow', {}, 'none'],
    ['going offline suspends at once', 'network', { reachable: false }, 'suspend_now'],
    ['coming online waits to settle', 'network', {}, 'schedule_online'],
    ['a settled network resumes a suspended page', 'online_settled', { suspended: true }, 'resume'],
    [
      'a settled network reconnects a broken socket',
      'online_settled',
      { ready: false },
      'force_reconnect',
    ],
    ['a settled network leaves a ready socket', 'online_settled', {}, 'none'],
    [
      'a settled network skips a hidden page',
      'online_settled',
      { hidden: true, ready: false },
      'none',
    ],
    [
      'a settled network skips without a transport',
      'online_settled',
      { hasTransport: false },
      'none',
    ],
    [
      'a network that dropped again skips',
      'online_settled',
      { reachable: false, ready: false },
      'none',
    ],
  ])('%s', (_label, event, state, expected) => {
    expect(decideConnectionWake(event, { ...live, ...state })).toBe(expected);
  });
});
