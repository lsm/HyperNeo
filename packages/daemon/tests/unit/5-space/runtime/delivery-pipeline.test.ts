import { describe, expect, test } from 'bun:test';
import {
  classifyExternalEventDelivery,
  type ExternalEventDeliveryDecision,
  type ExternalEventDeliveryInput,
} from '../../../../src/lib/external-events/delivery-pipeline';

function makeInput(
  overrides: Partial<ExternalEventDeliveryInput> = {}
): ExternalEventDeliveryInput {
  return {
    deliveryTerminal: false,
    deliveryInFlight: false,
    subscriptionActive: true,
    taskDecision: { action: 'deliver' },
    targetHasSession: false,
    targetSessionLive: false,
    targetSpacePaused: false,
    executionPendingActivation: false,
    ...overrides,
  };
}

describe('external-event delivery decision pipeline', () => {
  const cases: Array<[string, Partial<ExternalEventDeliveryInput>, ExternalEventDeliveryDecision]> =
    [
      ['terminal delivery skips', { deliveryTerminal: true }, { action: 'skip' }],
      [
        'in-flight delivery records claim conflict',
        { deliveryInFlight: true },
        { action: 'skipClaimConflict' },
      ],
      [
        'dropped subscription fails terminally',
        { subscriptionActive: false },
        { action: 'failDelivery', reason: 'subscription_no_longer_active' },
      ],
      [
        'task admission failure propagates its reason',
        { taskDecision: { action: 'fail', reason: 'invalid_target_ownership' } },
        { action: 'failDelivery', reason: 'invalid_target_ownership' },
      ],
      [
        'stopped task defers delivery',
        { taskDecision: { action: 'hold' } },
        { action: 'deferStoppedTask' },
      ],
      [
        'live session in a paused space defers without retry',
        { targetHasSession: true, targetSessionLive: true, targetSpacePaused: true },
        { action: 'deferPausedSpace' },
      ],
      [
        'live session delivers',
        { targetHasSession: true, targetSessionLive: true },
        { action: 'deliverLiveSession' },
      ],
      [
        'dead session id delivers via stale-session path',
        { targetHasSession: true },
        { action: 'deliverStaleSession' },
      ],
      [
        'pending node execution queues with preserved attempt count',
        { executionPendingActivation: true },
        {
          action: 'queueForActivation',
          reason: 'deliveryMode:defer; node_execution_pending',
          preserveAttemptCount: true,
        },
      ],
      [
        'no session and no pending execution activates the target',
        {},
        { action: 'activateTarget' },
      ],
    ];

  for (const [label, overrides, expected] of cases) {
    test(label, async () => {
      expect(classifyExternalEventDelivery(makeInput(overrides))).toEqual(expected);
    });
  }

  describe('gate precedence — first decision wins', () => {
    test('terminal beats every downstream gate', async () => {
      const decision = classifyExternalEventDelivery(
        makeInput({
          deliveryTerminal: true,
          deliveryInFlight: true,
          subscriptionActive: false,
          taskDecision: { action: 'fail', reason: 'target_task_terminal' },
          targetHasSession: true,
          targetSessionLive: true,
        })
      );
      expect(decision).toEqual({ action: 'skip' });
    });

    test('claim conflict beats subscription and admission gates', async () => {
      const decision = classifyExternalEventDelivery(
        makeInput({
          deliveryInFlight: true,
          subscriptionActive: false,
          taskDecision: { action: 'fail', reason: 'target_task_terminal' },
        })
      );
      expect(decision).toEqual({ action: 'skipClaimConflict' });
    });

    test('subscription gate beats task admission and routing', async () => {
      const decision = classifyExternalEventDelivery(
        makeInput({
          subscriptionActive: false,
          taskDecision: { action: 'fail', reason: 'target_task_terminal' },
          targetHasSession: true,
          targetSessionLive: true,
        })
      );
      expect(decision).toEqual({ action: 'failDelivery', reason: 'subscription_no_longer_active' });
    });

    test('task admission beats session routing', async () => {
      const decision = classifyExternalEventDelivery(
        makeInput({
          taskDecision: { action: 'fail', reason: 'target_task_terminal' },
          targetHasSession: true,
          targetSessionLive: true,
        })
      );
      expect(decision).toEqual({ action: 'failDelivery', reason: 'target_task_terminal' });
    });

    test('live-session routing wins over pending execution and activation', async () => {
      const decision = classifyExternalEventDelivery(
        makeInput({
          targetHasSession: true,
          targetSessionLive: true,
          executionPendingActivation: true,
        })
      );
      expect(decision).toEqual({ action: 'deliverLiveSession' });
    });

    test('pending execution wins over activation only when no session exists', async () => {
      const decision = classifyExternalEventDelivery(
        makeInput({ executionPendingActivation: true })
      );
      expect(decision.action).toBe('queueForActivation');
    });
  });

  describe('classification precedence', () => {
    test('a terminal delivery skips before anything else is considered', () => {
      expect(
        classifyExternalEventDelivery(
          makeInput({
            deliveryTerminal: true,
            deliveryInFlight: true,
            subscriptionActive: false,
          })
        )
      ).toEqual({ action: 'skip' });
    });

    test('an in-flight delivery reports a claim conflict', () => {
      expect(
        classifyExternalEventDelivery(
          makeInput({ deliveryInFlight: true, subscriptionActive: false })
        )
      ).toEqual({ action: 'skipClaimConflict' });
    });

    test('a dead subscription fails the delivery', () => {
      expect(classifyExternalEventDelivery(makeInput({ subscriptionActive: false }))).toEqual({
        action: 'failDelivery',
        reason: 'subscription_no_longer_active',
      });
    });

    test('a held task defers, and a refused one fails with its reason', () => {
      expect(
        classifyExternalEventDelivery(makeInput({ taskDecision: { action: 'hold' } }))
      ).toEqual({ action: 'deferStoppedTask' });
      expect(
        classifyExternalEventDelivery(
          makeInput({ taskDecision: { action: 'refuse', reason: 'task_cancelled' } })
        )
      ).toEqual({ action: 'failDelivery', reason: 'task_cancelled' });
    });

    test('session routing decides live, stale and paused ahead of activation', () => {
      expect(
        classifyExternalEventDelivery(
          makeInput({ targetHasSession: true, targetSessionLive: true })
        )
      ).toEqual({ action: 'deliverLiveSession' });
      expect(
        classifyExternalEventDelivery(
          makeInput({ targetHasSession: true, targetSessionLive: false })
        )
      ).toEqual({ action: 'deliverStaleSession' });
      expect(
        classifyExternalEventDelivery(
          makeInput({ targetHasSession: true, targetSessionLive: true, targetSpacePaused: true })
        )
      ).toEqual({ action: 'deferPausedSpace' });
    });

    test('activation routing is the final arbiter when no session is attached', () => {
      expect(
        classifyExternalEventDelivery(makeInput({ executionPendingActivation: true }))
      ).toEqual({
        action: 'queueForActivation',
        reason: 'deliveryMode:defer; node_execution_pending',
        preserveAttemptCount: true,
      });
      expect(classifyExternalEventDelivery(makeInput({}))).toEqual({ action: 'activateTarget' });
    });
  });
});
