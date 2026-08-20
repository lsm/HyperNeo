import { describe, expect, test } from 'bun:test';
import {
  buildNodeNameResolver,
  buildSlotToNodeMap,
  resolveNodeAgentTargets,
  type ResolveNodeAgentTargetsInput,
} from '../../../../src/lib/space/runtime/agent-message-routing-gates';

function makeInput(
  overrides: Partial<ResolveNodeAgentTargetsInput> = {}
): ResolveNodeAgentTargetsInput {
  return {
    target: 'reviewer',
    fromAgentName: 'coder',
    fromNodeName: 'coder',
    peerAgentNames: [],
    declaredAgentNames: [],
    permittedTargets: [],
    spaceAgentAvailable: false,
    canSend: () => true,
    ...overrides,
  };
}

describe('resolveNodeAgentTargets: broadcast * target', () => {
  test('resolves to the permitted targets', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({ target: '*', permittedTargets: ['reviewer', 'security'] })
    );

    expect(outcome).toEqual({
      status: 'resolved',
      targetAgentNames: ['reviewer', 'security'],
    });
  });

  test('fails with the exact no-permitted-targets reason when permitted targets are empty', () => {
    const outcome = resolveNodeAgentTargets(makeInput({ target: '*', permittedTargets: [] }));

    expect(outcome).toEqual({
      status: 'noPermittedTargets',
      reason: `No permitted targets for agent 'coder' in the declared channel topology.`,
    });
  });

  test('filters broadcast targets through the authorization predicate', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: '*',
        permittedTargets: ['reviewer', 'security'],
        canSend: (_fromNode, toNode) => toNode === 'reviewer',
      })
    );

    expect(outcome).toEqual({
      status: 'unauthorized',
      unauthorized: ['security'],
      permittedTargets: ['reviewer', 'security'],
      reason:
        `Channel topology does not permit 'coder' to send to: security. ` +
        `Permitted targets: reviewer, security.`,
    });
  });
});

describe('resolveNodeAgentTargets: array target', () => {
  test('uses array targets verbatim without resolving them', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: ['ghost-a', 'reviewer', 'ghost-b'],
        peerAgentNames: ['reviewer'],
        declaredAgentNames: ['reviewer'],
      })
    );

    expect(outcome).toEqual({
      status: 'resolved',
      targetAgentNames: ['ghost-a', 'reviewer', 'ghost-b'],
    });
  });

  test('filters array targets through the authorization predicate', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: ['reviewer', 'security'],
        permittedTargets: ['reviewer'],
        canSend: (_fromNode, toNode) => toNode === 'reviewer',
      })
    );

    expect(outcome).toEqual({
      status: 'unauthorized',
      unauthorized: ['security'],
      permittedTargets: ['reviewer'],
      reason:
        `Channel topology does not permit 'coder' to send to: security. ` +
        `Permitted targets: reviewer.`,
    });
  });

  test('skips the authorization predicate for space-agent entries in array targets', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: ['space-agent', 'reviewer'],
        spaceAgentAvailable: true,
        declaredAgentNames: ['reviewer'],
        canSend: (_fromNode, toNode) => toNode === 'reviewer',
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['space-agent', 'reviewer'] });
  });
});

describe('resolveNodeAgentTargets: space-agent target', () => {
  test('passes space-agent through without the authorization predicate when available', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'space-agent',
        spaceAgentAvailable: true,
        canSend: () => {
          throw new Error('canSend must not be consulted for space-agent');
        },
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['space-agent'] });
  });

  test('falls back to the plain-name cascade when space-agent is unavailable', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'space-agent',
        spaceAgentAvailable: false,
        peerAgentNames: ['reviewer'],
      })
    );

    expect(outcome.status).toBe('unknownTarget');
    if (outcome.status === 'unknownTarget') {
      expect(outcome.target).toBe('space-agent');
      expect(outcome.allTargets).toEqual(['reviewer']);
    }
  });
});

describe('resolveNodeAgentTargets: plain-name precedence', () => {
  test('live-peer match wins over node-group expansion', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'review-node',
        peerAgentNames: ['review-node'],
        nodeGroups: { 'review-node': ['reviewer', 'security'] },
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['review-node'] });
  });

  test('node-group expansion wins over declared agent names', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'review-node',
        nodeGroups: { 'review-node': ['reviewer'] },
        declaredAgentNames: ['review-node'],
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['reviewer'] });
  });

  test('declared agent name resolves without a live session', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({ target: 'reviewer', declaredAgentNames: new Set(['reviewer']) })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['reviewer'] });
  });

  test('topology-declared target resolves directly from permitted targets', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({ target: 'reviewer', permittedTargets: ['reviewer'] })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['reviewer'] });
  });

  test('topology-declared node target resolves directly with node groups present', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'Review',
        fromNodeName: 'Coding',
        nodeGroups: { Coding: ['coder'] },
        permittedTargets: ['Review'],
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['Review'] });
  });

  test('node-group expansion preempts slot-resolved topology declaration', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'Review',
        nodeGroups: { Review: ['reviewer'] },
        permittedTargets: ['reviewer'],
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['reviewer'] });
  });

  test('expands a node group with an empty slot list to zero targets', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'Review',
        nodeGroups: { Review: [] },
        permittedTargets: ['Review'],
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: [] });
  });
});

describe('resolveNodeAgentTargets: unknown target', () => {
  test('builds the sorted reachable-target list with space-agent appended last', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'ghost',
        peerAgentNames: ['zebra-agent', 'alpha-agent', 'alpha-agent'],
        nodeGroups: { 'beta-node': ['reviewer'] },
        declaredAgentNames: new Set(['gamma-slot']),
        spaceAgentAvailable: true,
      })
    );

    expect(outcome).toEqual({
      status: 'unknownTarget',
      target: 'ghost',
      allTargets: ['alpha-agent', 'beta-node', 'gamma-slot', 'zebra-agent', 'space-agent'],
      reason:
        `Unknown target 'ghost': no agent or node found with this name. ` +
        `Reachable targets: alpha-agent, beta-node, gamma-slot, zebra-agent, space-agent.`,
    });
  });

  test('reports no reachable targets when every source is empty', () => {
    const outcome = resolveNodeAgentTargets(makeInput({ target: 'ghost' }));

    expect(outcome).toEqual({
      status: 'unknownTarget',
      target: 'ghost',
      allTargets: [],
      reason:
        `Unknown target 'ghost': no agent or node found with this name. ` +
        `No reachable targets available.`,
    });
  });
});

describe('resolveNodeAgentTargets: authorization filter', () => {
  test('reports unauthorized resolved targets with the exact reason', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'reviewer',
        declaredAgentNames: ['reviewer'],
        permittedTargets: ['qa'],
        canSend: () => false,
      })
    );

    expect(outcome).toEqual({
      status: 'unauthorized',
      unauthorized: ['reviewer'],
      permittedTargets: ['qa'],
      reason:
        `Channel topology does not permit 'coder' to send to: reviewer. ` +
        `Permitted targets: qa.`,
    });
  });

  test('renders the permitted-targets fallback as none when the list is empty', () => {
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'reviewer',
        declaredAgentNames: ['reviewer'],
        permittedTargets: [],
        canSend: () => false,
      })
    );

    expect(outcome).toEqual({
      status: 'unauthorized',
      unauthorized: ['reviewer'],
      permittedTargets: [],
      reason:
        `Channel topology does not permit 'coder' to send to: reviewer. ` +
        `Permitted targets: none.`,
    });
  });

  test('resolves slot targets through the node-name resolver before authorization', () => {
    const calls: Array<[string, string]> = [];
    const outcome = resolveNodeAgentTargets(
      makeInput({
        target: 'reviewer',
        nodeGroups: { Review: ['reviewer'] },
        declaredAgentNames: ['reviewer'],
        canSend: (fromNode, toNode) => {
          calls.push([fromNode, toNode]);
          return true;
        },
      })
    );

    expect(outcome).toEqual({ status: 'resolved', targetAgentNames: ['reviewer'] });
    expect(calls).toEqual([['coder', 'Review']]);
  });
});

describe('buildSlotToNodeMap', () => {
  test('maps every slot of each node group', () => {
    expect(buildSlotToNodeMap({ 'review-node': ['reviewer', 'security'], qa: ['qa'] })).toEqual(
      new Map([
        ['reviewer', 'review-node'],
        ['security', 'review-node'],
        ['qa', 'qa'],
      ])
    );
  });

  test('returns an empty map without node groups', () => {
    expect(buildSlotToNodeMap(undefined)).toEqual(new Map());
  });

  test('keeps the last mapping for a slot declared in two node groups', () => {
    expect(buildSlotToNodeMap({ 'node-a': ['shared'], 'node-b': ['shared'] })).toEqual(
      new Map([['shared', 'node-b']])
    );
  });
});

describe('buildNodeNameResolver', () => {
  test('resolves slots and passes node names through', () => {
    const resolveNodeName = buildNodeNameResolver(
      buildSlotToNodeMap({ Coding: ['coder'], Review: ['reviewer'] })
    );

    expect(resolveNodeName('coder')).toBe('Coding');
    expect(resolveNodeName('reviewer')).toBe('Review');
    expect(resolveNodeName('Coding')).toBe('Coding');
    expect(resolveNodeName('unmapped')).toBe('unmapped');
  });
});
