import { describe, expect, test } from 'bun:test';
import {
  type ResolveNodeAgentTargetsInput,
  type ResolveNodeAgentTargetsOutcome,
  resolveNodeAgentTargets,
} from '../../../../src/lib/messaging/routing-gates';
import {
  type AgentMessageRoutingDecision,
  type AgentMessageRoutingInput,
  classifyAgentMessageRouting,
  decideAgentMessageRouting,
  isGenericAddress,
} from '../../../../src/lib/messaging/routing-pipeline';

const noPermittedReason = `No permitted targets for agent 'coder' in the declared channel topology.`;
const unknownGhostReason =
  `Unknown target 'ghost': no agent or node found with this name. ` +
  `Reachable targets: reviewer.`;
const unauthorizedReason =
  `Channel topology does not permit 'coder' to send to: security. ` +
  `Permitted targets: reviewer.`;

function resolvedOutcome(targetAgentNames: string[]): ResolveNodeAgentTargetsOutcome {
  return { status: 'resolved', targetAgentNames };
}

function unknownGhostOutcome(): ResolveNodeAgentTargetsOutcome {
  return {
    status: 'unknownTarget',
    target: 'ghost',
    allTargets: ['reviewer'],
    reason: unknownGhostReason,
  };
}

function makeInput(overrides: Partial<AgentMessageRoutingInput> = {}): AgentMessageRoutingInput {
  return {
    target: 'reviewer',
    requestedTargets: ['reviewer'],
    topologyEmpty: false,
    resolution: resolvedOutcome(['reviewer']),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<AgentMessageRoutingInput> = {}
): AgentMessageRoutingInput & { decision: null } {
  return { ...makeInput(overrides), decision: null };
}

function resolveAsRouterDoes(
  overrides: Partial<ResolveNodeAgentTargetsInput> = {}
): ResolveNodeAgentTargetsOutcome {
  return resolveNodeAgentTargets({
    target: 'reviewer',
    fromAgentName: 'coder',
    fromNodeName: 'coder',
    peerAgentNames: [],
    declaredAgentNames: [],
    permittedTargets: [],
    canSend: () => true,
    ...overrides,
  });
}

describe('agent message routing decision pipeline', () => {
  const cases: Array<[string, Partial<AgentMessageRoutingInput>, AgentMessageRoutingDecision]> = [
    [
      'all-generic targets delegate to the generic delivery path',
      { target: '@coordinator', requestedTargets: ['@coordinator'] },
      { action: 'delegateGeneric' },
    ],
    [
      'mixed generic and plain targets stay on the plain path',
      {
        target: ['@coordinator', 'reviewer'],
        requestedTargets: ['@coordinator', 'reviewer'],
      },
      { action: 'routeTargets', targetAgentNames: ['reviewer'] },
    ],
    [
      'broadcast * stays on the plain path',
      { target: '*', requestedTargets: ['*'] },
      { action: 'routeTargets', targetAgentNames: ['reviewer'] },
    ],
    ['empty topology fails', { topologyEmpty: true }, { action: 'failNoTopology' }],
    [
      'unknown targets fail with the resolution reason',
      { resolution: unknownGhostOutcome() },
      { action: 'failUnknownTarget', reason: unknownGhostReason },
    ],
    [
      'broadcast without permitted targets fails through the unknown-target action',
      { resolution: { status: 'noPermittedTargets', reason: noPermittedReason } },
      { action: 'failUnknownTarget', reason: noPermittedReason },
    ],
    [
      'unauthorized targets fail with the full authorization payload',
      {
        resolution: {
          status: 'unauthorized',
          unauthorized: ['security'],
          permittedTargets: ['reviewer'],
          reason: unauthorizedReason,
        },
      },
      {
        action: 'failUnauthorized',
        reason: unauthorizedReason,
        unauthorizedAgentNames: ['security'],
        permittedTargets: ['reviewer'],
      },
    ],
    [
      'resolved targets route to the resolved agent list',
      { resolution: resolvedOutcome(['reviewer', 'qa']) },
      { action: 'routeTargets', targetAgentNames: ['reviewer', 'qa'] },
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    test(label, () => {
      expect(decideAgentMessageRouting(makeInput(overrides))).toEqual(expected);
    });
  }

  describe('gate precedence — first decision wins', () => {
    test('generic dispatch beats the topology guard', () => {
      const decision = decideAgentMessageRouting(
        makeInput({
          target: '@coordinator',
          requestedTargets: ['@coordinator'],
          topologyEmpty: true,
          resolution: unknownGhostOutcome(),
        })
      );
      expect(decision).toEqual({ action: 'delegateGeneric' });
    });

    test('resolution beats authz', () => {
      const resolution = resolveAsRouterDoes({
        target: 'ghost',
        permittedTargets: ['reviewer'],
        canSend: () => false,
      });
      const decision = decideAgentMessageRouting(makeInput({ resolution }));
      expect(decision).toEqual({
        action: 'failUnknownTarget',
        reason:
          `Unknown target 'ghost': no agent or node found with this name. ` +
          `No reachable targets available.`,
      });
    });

    test('live peer beats node group beats declared beats topology-declared', () => {
      const route = (resolution: ResolveNodeAgentTargetsOutcome) =>
        decideAgentMessageRouting(
          makeInput({ target: 'review', requestedTargets: ['review'], resolution })
        );

      expect(
        route(
          resolveAsRouterDoes({
            target: 'review',
            peerAgentNames: ['review'],
            nodeGroups: { review: ['security'] },
            declaredAgentNames: ['review'],
            permittedTargets: ['review'],
          })
        )
      ).toEqual({ action: 'routeTargets', targetAgentNames: ['review'] });

      expect(
        route(
          resolveAsRouterDoes({
            target: 'review',
            nodeGroups: { review: ['security'] },
            declaredAgentNames: ['review'],
            permittedTargets: ['review'],
          })
        )
      ).toEqual({ action: 'routeTargets', targetAgentNames: ['security'] });

      expect(
        route(
          resolveAsRouterDoes({
            target: 'review',
            declaredAgentNames: ['review'],
            permittedTargets: ['review'],
          })
        )
      ).toEqual({ action: 'routeTargets', targetAgentNames: ['review'] });

      expect(
        route(resolveAsRouterDoes({ target: 'review', permittedTargets: ['review'] }))
      ).toEqual({ action: 'routeTargets', targetAgentNames: ['review'] });
    });
  });

  describe('classification precedence', () => {
    test('a generic address delegates before anything else is considered', () => {
      expect(
        classifyAgentMessageRouting(
          makeCtx({
            requestedTargets: ['@coordinator'],
            topologyEmpty: true,
            resolution: { status: 'noPermittedTargets', reason: noPermittedReason },
          })
        )
      ).toEqual({ action: 'delegateGeneric' });
    });

    test('an empty topology fails before the target is resolved', () => {
      expect(
        classifyAgentMessageRouting(
          makeCtx({
            requestedTargets: ['reviewer'],
            topologyEmpty: true,
            resolution: unknownGhostOutcome(),
          })
        )
      ).toEqual({ action: 'failNoTopology' });
    });

    test('an unauthorized target reports the unauthorized names and permitted targets', () => {
      expect(
        classifyAgentMessageRouting(
          makeCtx({
            requestedTargets: ['reviewer'],
            resolution: {
              status: 'unauthorized',
              unauthorized: ['security'],
              permittedTargets: ['reviewer'],
              reason: unauthorizedReason,
            },
          })
        )
      ).toEqual({
        action: 'failUnauthorized',
        reason: unauthorizedReason,
        unauthorizedAgentNames: ['security'],
        permittedTargets: ['reviewer'],
      });
    });

    test('a resolved target routes to every resolved agent', () => {
      expect(
        classifyAgentMessageRouting(
          makeCtx({ requestedTargets: ['reviewer'], resolution: resolvedOutcome(['reviewer']) })
        )
      ).toEqual({ action: 'routeTargets', targetAgentNames: ['reviewer'] });
    });

    test('an unresolved target fails as unknown, reporting the reason', () => {
      expect(
        classifyAgentMessageRouting(
          makeCtx({ requestedTargets: ['ghost'], resolution: unknownGhostOutcome() })
        )
      ).toEqual({ action: 'failUnknownTarget', reason: unknownGhostReason });
    });

    test('a topology with no permitted targets is unknown rather than unauthorized', () => {
      expect(
        classifyAgentMessageRouting(
          makeCtx({
            requestedTargets: ['coder'],
            resolution: { status: 'noPermittedTargets', reason: noPermittedReason },
          })
        )
      ).toEqual({ action: 'failUnknownTarget', reason: noPermittedReason });
    });
  });

  describe('isGenericAddress', () => {
    test('accepts a parseable address and rejects a bare name', () => {
      expect(isGenericAddress('@coordinator')).toBe(true);
      expect(isGenericAddress('reviewer')).toBe(false);
    });
  });
});
