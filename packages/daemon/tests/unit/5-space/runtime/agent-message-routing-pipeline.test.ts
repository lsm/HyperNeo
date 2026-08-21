import { describe, expect, test } from 'bun:test';
import {
  type ResolveNodeAgentTargetsInput,
  type ResolveNodeAgentTargetsOutcome,
  resolveNodeAgentTargets,
} from '../../../../src/lib/space/runtime/agent-message-routing-gates';
import {
  type AgentMessageRoutingCtx,
  type AgentMessageRoutingDecision,
  type AgentMessageRoutingInput,
  applyEmptyTopologyGate,
  applyGenericAddressDispatchGate,
  applyTargetResolutionGate,
  applyTopologyAuthorizationGate,
  decideAgentMessageRouting,
} from '../../../../src/lib/space/runtime/agent-message-routing-pipeline';

const noPermittedReason = `No permitted targets for agent 'coder' in the declared channel topology.`;
const unknownGhostReason =
  `Unknown target 'ghost': no agent or node found with this name. ` +
  `Reachable targets: reviewer, space-agent.`;
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
    allTargets: ['reviewer', 'space-agent'],
    reason: unknownGhostReason,
  };
}

function makeInput(overrides: Partial<AgentMessageRoutingInput> = {}): AgentMessageRoutingInput {
  return {
    target: 'reviewer',
    requestedTargets: ['reviewer'],
    topologyEmpty: false,
    spaceAgentAvailable: false,
    resolution: resolvedOutcome(['reviewer']),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<AgentMessageRoutingInput> = {}): AgentMessageRoutingCtx {
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
    spaceAgentAvailable: false,
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
    [
      'empty topology without space-agent fails',
      { topologyEmpty: true },
      { action: 'failNoTopology' },
    ],
    [
      'empty topology with an available space-agent proceeds',
      {
        target: 'space-agent',
        requestedTargets: ['space-agent'],
        topologyEmpty: true,
        spaceAgentAvailable: true,
        resolution: resolvedOutcome(['space-agent']),
      },
      { action: 'routeTargets', targetAgentNames: ['space-agent'] },
    ],
    [
      'empty topology still fails when space-agent is wanted but unavailable',
      {
        target: 'space-agent',
        requestedTargets: ['space-agent'],
        topologyEmpty: true,
        spaceAgentAvailable: false,
      },
      { action: 'failNoTopology' },
    ],
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

  describe('gate pass-through contract', () => {
    test('gates with a no-op branch leave ctx untouched when not firing', () => {
      const noOpCases: Array<
        [(ctx: AgentMessageRoutingCtx) => AgentMessageRoutingCtx, Partial<AgentMessageRoutingInput>]
      > = [
        [applyGenericAddressDispatchGate, { target: 'reviewer', requestedTargets: ['reviewer'] }],
        [applyGenericAddressDispatchGate, { target: [], requestedTargets: [] }],
        [applyEmptyTopologyGate, { topologyEmpty: false }],
        [
          applyEmptyTopologyGate,
          {
            target: 'space-agent',
            requestedTargets: ['space-agent'],
            topologyEmpty: true,
            spaceAgentAvailable: true,
          },
        ],
        [applyTargetResolutionGate, { resolution: resolvedOutcome(['reviewer']) }],
        [
          applyTargetResolutionGate,
          {
            resolution: {
              status: 'unauthorized',
              unauthorized: ['security'],
              permittedTargets: ['reviewer'],
              reason: unauthorizedReason,
            },
          },
        ],
        [applyTopologyAuthorizationGate, { resolution: unknownGhostOutcome() }],
        [
          applyTopologyAuthorizationGate,
          { resolution: { status: 'noPermittedTargets', reason: noPermittedReason } },
        ],
      ];
      for (const [gate, overrides] of noOpCases) {
        const ctx = makeCtx(overrides);
        expect(gate(ctx)).toBe(ctx);
      }
    });

    test('topology authorization is the final arbiter for live outcomes', () => {
      expect(
        applyTopologyAuthorizationGate(makeCtx({ resolution: resolvedOutcome(['reviewer']) }))
          .decision
      ).toEqual({ action: 'routeTargets', targetAgentNames: ['reviewer'] });
      expect(
        applyTopologyAuthorizationGate(
          makeCtx({
            resolution: {
              status: 'unauthorized',
              unauthorized: ['security'],
              permittedTargets: ['reviewer'],
              reason: unauthorizedReason,
            },
          })
        ).decision
      ).toEqual({
        action: 'failUnauthorized',
        reason: unauthorizedReason,
        unauthorizedAgentNames: ['security'],
        permittedTargets: ['reviewer'],
      });
    });
  });
});
