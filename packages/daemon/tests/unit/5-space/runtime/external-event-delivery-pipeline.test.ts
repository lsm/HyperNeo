import { describe, expect, test } from 'bun:test';
import {
  applyClaimConflictGate,
  applyExecutionRoutingGate,
  applySessionRoutingGate,
  applySubscriptionGate,
  applyTaskAdmissionGate,
  applyTerminalGate,
  decideExternalEventDelivery,
  decidePostActivationDelivery,
  type ExternalEventDeliveryCtx,
  type ExternalEventDeliveryDecision,
  type ExternalEventDeliveryInput,
  type PostActivationDeliveryInput,
} from '../../../../src/lib/space/runtime/external-event-delivery-pipeline';

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

function makeCtx(overrides: Partial<ExternalEventDeliveryInput> = {}): ExternalEventDeliveryCtx {
  return { ...makeInput(overrides), decision: null };
}

function makePostInput(
  overrides: Partial<PostActivationDeliveryInput> = {}
): PostActivationDeliveryInput {
  return {
    activationError: null,
    activatedTargetFound: true,
    activatedHasSession: true,
    activatedSessionLive: true,
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
      expect(decideExternalEventDelivery(makeInput(overrides))).toEqual(expected);
    });
  }

  describe('gate precedence — first decision wins', () => {
    test('terminal beats every downstream gate', async () => {
      const decision = decideExternalEventDelivery(
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
      const decision = decideExternalEventDelivery(
        makeInput({
          deliveryInFlight: true,
          subscriptionActive: false,
          taskDecision: { action: 'fail', reason: 'target_task_terminal' },
        })
      );
      expect(decision).toEqual({ action: 'skipClaimConflict' });
    });

    test('subscription gate beats task admission and routing', async () => {
      const decision = decideExternalEventDelivery(
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
      const decision = decideExternalEventDelivery(
        makeInput({
          taskDecision: { action: 'fail', reason: 'target_task_terminal' },
          targetHasSession: true,
          targetSessionLive: true,
        })
      );
      expect(decision).toEqual({ action: 'failDelivery', reason: 'target_task_terminal' });
    });

    test('live-session routing wins over pending execution and activation', async () => {
      const decision = decideExternalEventDelivery(
        makeInput({
          targetHasSession: true,
          targetSessionLive: true,
          executionPendingActivation: true,
        })
      );
      expect(decision).toEqual({ action: 'deliverLiveSession' });
    });

    test('pending execution wins over activation only when no session exists', async () => {
      const decision = decideExternalEventDelivery(makeInput({ executionPendingActivation: true }));
      expect(decision.action).toBe('queueForActivation');
    });
  });

  describe('gate pass-through contract', () => {
    test('gates with a no-op branch leave ctx untouched when not firing', () => {
      const noOpCases: Array<
        [
          (ctx: ExternalEventDeliveryCtx) => ExternalEventDeliveryCtx,
          Partial<ExternalEventDeliveryInput>,
        ]
      > = [
        [applyTerminalGate, { deliveryTerminal: false }],
        [applyClaimConflictGate, { deliveryInFlight: false }],
        [applySubscriptionGate, { subscriptionActive: true }],
        [applyTaskAdmissionGate, { taskDecision: { action: 'deliver' } }],
        [applySessionRoutingGate, { targetHasSession: false }],
      ];
      for (const [gate, overrides] of noOpCases) {
        const ctx = makeCtx(overrides);
        expect(gate(ctx)).toBe(ctx);
      }
    });

    test('execution routing is the final arbiter and always decides', () => {
      expect(
        applyExecutionRoutingGate(makeCtx({ executionPendingActivation: true })).decision
      ).not.toBeNull();
      expect(applyExecutionRoutingGate(makeCtx({})).decision).toEqual({
        action: 'activateTarget',
      });
    });
  });
});

describe('post-activation delivery decision pipeline', () => {
  const cases: Array<
    [string, Partial<PostActivationDeliveryInput>, ExternalEventDeliveryDecision]
  > = [
    [
      'activation failure queues with the failure reason',
      { activationError: 'session spawn blew up' },
      {
        action: 'queueForActivation',
        reason: 'deliveryMode:defer; activation_failed; session spawn blew up',
      },
    ],
    ['activated live session delivers', {}, { action: 'deliverLiveSession' }],
    [
      'activated dead session id delivers via stale-session path',
      { activatedSessionLive: false },
      { action: 'deliverStaleSession' },
    ],
    [
      'activated target without a session defers not-active',
      { activatedHasSession: false },
      { action: 'deferNotActive' },
    ],
    [
      'no activated target queues with paused-space retry guard',
      {
        activatedTargetFound: false,
        activatedHasSession: false,
        activatedSessionLive: false,
      },
      {
        action: 'queueForActivation',
        reason: 'deliveryMode:defer; node_execution_not_active',
        retryUnlessPaused: true,
      },
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    test(label, async () => {
      expect(decidePostActivationDelivery(makePostInput(overrides))).toEqual(expected);
    });
  }

  test('activation error beats every routing outcome', async () => {
    const decision = decidePostActivationDelivery(makePostInput({ activationError: 'boom' }));
    expect(decision).toEqual({
      action: 'queueForActivation',
      reason: 'deliveryMode:defer; activation_failed; boom',
    });
  });
});
