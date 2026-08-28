import { describe, expect, it } from 'bun:test';
import {
  type HandlerOutcomeRoute,
  routeFeedSteerOutcome,
} from '../../../../src/lib/agent/handler-outcome-routing';
import {
  MAX_ACP_STEER_PARKS,
  MAX_STEER_PARKS,
  MESSAGE_DELIVERY_PARK_MS,
} from '../../../../src/lib/agent/message-delivery';

const NOW = 1_000_000;
const PARK_AT = NOW + MESSAGE_DELIVERY_PARK_MS;

const STEER_PARK_DEAD_LETTER = 'Steer parked past its budget — owning turn never unblocked';
const ACP_DEAD_LETTER = 'ACP steer awaited acceptance past its budget — subprocess never accepted';
const ACK_DEAD_LETTER =
  'Steer acknowledgment timed out past its budget — query never consumed the steer';

const deadLetter = (reason: string): HandlerOutcomeRoute => ({ deadLetter: reason });

const requeueParkedAs = (
  parked: 'turn_blocked' | 'acp_awaiting_acceptance' | 'steer_ack_timeout'
): HandlerOutcomeRoute => ({
  mutation: 'requeueParked',
  retryAt: PARK_AT,
  settleSkipped: false,
  result: { parked, retryAt: PARK_AT },
});

const requeueGateOpen = (): HandlerOutcomeRoute => ({
  mutation: 'requeue',
  retryAt: PARK_AT,
  settleSkipped: false,
  result: { parked: 'turn_blocked_gate_open', retryAt: PARK_AT },
});

describe('routeFeedSteerOutcome budget boundary gates', () => {
  const ROWS = [
    {
      label: 'park at the steer budget dead-letters',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: false,
      expected: deadLetter(STEER_PARK_DEAD_LETTER),
    },
    {
      label: 'park over the steer budget still dead-letters',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS + 1,
      waitingForInput: false,
      expected: deadLetter(STEER_PARK_DEAD_LETTER),
    },
    {
      label: 'park while waiting for input at the budget bypasses the dead-letter',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: true,
      expected: requeueGateOpen(),
    },
    {
      label: 'park while waiting for input over the budget still bypasses',
      feed: { outcome: 'park' },
      parkCount: MAX_STEER_PARKS + 1,
      waitingForInput: true,
      expected: requeueGateOpen(),
    },
    {
      label: 'park at the far larger ACP budget does not get the ACP budget',
      feed: { outcome: 'park' },
      parkCount: MAX_ACP_STEER_PARKS,
      waitingForInput: false,
      expected: deadLetter(STEER_PARK_DEAD_LETTER),
    },
    {
      label: 'awaiting_acceptance at the steer budget is under the ACP budget and parks',
      feed: { outcome: 'awaiting_acceptance' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: false,
      expected: requeueParkedAs('acp_awaiting_acceptance'),
    },
    {
      label: 'awaiting_acceptance at the ACP budget dead-letters',
      feed: { outcome: 'awaiting_acceptance' },
      parkCount: MAX_ACP_STEER_PARKS,
      waitingForInput: false,
      expected: deadLetter(ACP_DEAD_LETTER),
    },
    {
      label: 'awaiting_acceptance over the ACP budget still dead-letters',
      feed: { outcome: 'awaiting_acceptance' },
      parkCount: MAX_ACP_STEER_PARKS + 1,
      waitingForInput: false,
      expected: deadLetter(ACP_DEAD_LETTER),
    },
    {
      label: 'awaiting_acceptance while waiting for input does not bypass the ACP budget',
      feed: { outcome: 'awaiting_acceptance' },
      parkCount: MAX_ACP_STEER_PARKS,
      waitingForInput: true,
      expected: deadLetter(ACP_DEAD_LETTER),
    },
    {
      label: 'ack_timeout at the steer budget dead-letters',
      feed: { outcome: 'ack_timeout' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: false,
      expected: deadLetter(ACK_DEAD_LETTER),
    },
    {
      label: 'ack_timeout over the steer budget still dead-letters',
      feed: { outcome: 'ack_timeout' },
      parkCount: MAX_STEER_PARKS + 1,
      waitingForInput: false,
      expected: deadLetter(ACK_DEAD_LETTER),
    },
    {
      label: 'ack_timeout while waiting for input does not bypass the steer budget',
      feed: { outcome: 'ack_timeout' },
      parkCount: MAX_STEER_PARKS,
      waitingForInput: true,
      expected: deadLetter(ACK_DEAD_LETTER),
    },
    {
      label: 'aborted over the steer budget still aborts without dead-lettering',
      feed: { outcome: 'aborted' },
      parkCount: MAX_STEER_PARKS + 1,
      waitingForInput: false,
      expected: { mutation: 'none', settleSkipped: true, result: { outcome: 'aborted' } },
    },
    {
      label: 'consumed over the steer budget still completes without a queue mutation',
      feed: { outcome: 'consumed' },
      parkCount: MAX_STEER_PARKS + 1,
      waitingForInput: false,
      expected: { mutation: 'none', settleSkipped: false, result: { outcome: 'consumed' } },
    },
    {
      label: 'promote over the steer budget still promotes to a turn requeued immediately',
      feed: { outcome: 'promote' },
      parkCount: MAX_STEER_PARKS + 1,
      waitingForInput: false,
      expected: {
        mutation: 'requeueAs',
        requeueRole: 'turn',
        retryAt: NOW,
        settleSkipped: false,
        result: { outcome: 'superseded', promoted: 'turn' },
      },
    },
  ];

  it.each(ROWS.map((row) => [row.label, row] as const))('%s', (_label, row) => {
    expect(
      routeFeedSteerOutcome(row.feed, {
        parkCount: row.parkCount,
        waitingForInput: row.waitingForInput,
        now: NOW,
      })
    ).toEqual(row.expected);
  });

  it('waiting for input switches a park from the parked queue to a plain requeue', () => {
    const route = (waitingForInput: boolean) =>
      routeFeedSteerOutcome({ outcome: 'park' }, { parkCount: 0, waitingForInput, now: NOW });
    expect(route(true)).toEqual(requeueGateOpen());
    expect(route(false)).toEqual(requeueParkedAs('turn_blocked'));
  });
});
