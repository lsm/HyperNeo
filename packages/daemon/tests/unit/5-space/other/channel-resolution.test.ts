/**
 * Channel validation tests.
 *
 * Covers: validateChannels() for the new node-to-node channel model.
 * Channels use node names (WorkflowNode.name) as from/to addresses.
 * Node names must be unique within a workflow.
 */

import { describe, test, expect } from 'bun:test';
import type { SpaceWorkerAgent, SpaceWorkflow, WorkflowNode } from '@hyperneo/shared';
import { validateChannels } from '@hyperneo/shared';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(id: string, name = id): SpaceWorkerAgent {
  return { id, spaceId: 'space-1', name, instructions: null, createdAt: 0, updatedAt: 0 };
}

function makeNode(id: string, name: string, agentId = 'agent-coder'): WorkflowNode {
  return { id, name, agents: [{ agentId, name: 'agent-slot' }] };
}

function makeWorkflow(nodes: WorkflowNode[], channels?: SpaceWorkflow['channels']): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    nodes,
    startNodeId: nodes[0]?.id ?? '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    channels,
  };
}

const agentCoder = makeAgent('agent-coder', 'Coder');
const agentReviewer = makeAgent('agent-reviewer', 'Reviewer');
const allAgents = [agentCoder, agentReviewer];

// ============================================================================
// validateChannels tests
// ============================================================================

describe('validateChannels — node-to-node model', () => {
  test('returns no errors for a valid simple workflow', () => {
    const nodes = [
      makeNode('n1', 'Code', 'agent-coder'),
      makeNode('n2', 'Review', 'agent-reviewer'),
    ];
    const workflow = makeWorkflow(nodes, [{ id: 'ch-1', from: 'Code', to: 'Review' }]);
    expect(validateChannels(workflow, allAgents)).toEqual([]);
  });

  test('returns no errors for empty channels', () => {
    const nodes = [makeNode('n1', 'Code', 'agent-coder')];
    const workflow = makeWorkflow(nodes, []);
    expect(validateChannels(workflow, allAgents)).toEqual([]);
  });

  test('fan-out to multiple nodes is valid', () => {
    const nodes = [
      makeNode('n1', 'Code', 'agent-coder'),
      makeNode('n2', 'Review', 'agent-reviewer'),
      makeNode('n3', 'QA', 'agent-coder'),
    ];
    const workflow = makeWorkflow(nodes, [{ id: 'ch-1', from: 'Code', to: ['Review', 'QA'] }]);
    expect(validateChannels(workflow, [agentCoder, agentReviewer])).toEqual([]);
  });

  test('error when node names are not unique', () => {
    const nodes = [makeNode('n1', 'Code', 'agent-coder'), makeNode('n2', 'Code', 'agent-reviewer')];
    const workflow = makeWorkflow(nodes);
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('Code') && e.includes('unique'))).toBe(true);
  });

  test('error when channel.from references unknown node', () => {
    const nodes = [makeNode('n1', 'Code', 'agent-coder')];
    const workflow = makeWorkflow(nodes, [{ id: 'ch-1', from: 'Unknown', to: 'Code' }]);
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('Unknown'))).toBe(true);
  });

  test('error when channel.to references unknown node', () => {
    const nodes = [makeNode('n1', 'Code', 'agent-coder')];
    const workflow = makeWorkflow(nodes, [{ id: 'ch-1', from: 'Code', to: 'Unknown' }]);
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('Unknown'))).toBe(true);
  });

  test('error when channel id is missing', () => {
    const nodes = [
      makeNode('n1', 'Code', 'agent-coder'),
      makeNode('n2', 'Review', 'agent-reviewer'),
    ];
    const workflow = makeWorkflow(nodes, [{ id: '', from: 'Code', to: 'Review' }]);
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  test('wildcard from is allowed', () => {
    const nodes = [
      makeNode('n1', 'Code', 'agent-coder'),
      makeNode('n2', 'Review', 'agent-reviewer'),
    ];
    const workflow = makeWorkflow(nodes, [{ id: 'ch-1', from: '*', to: 'Review' }]);
    expect(validateChannels(workflow, allAgents)).toEqual([]);
  });

  test('back-channel: Review → Code is valid', () => {
    const nodes = [
      makeNode('n1', 'Code', 'agent-coder'),
      makeNode('n2', 'Review', 'agent-reviewer'),
    ];
    const workflow = makeWorkflow(nodes, [
      { id: 'ch-1', from: 'Code', to: 'Review' },
      { id: 'ch-2', from: 'Review', to: 'Code' },
    ]);
    expect(validateChannels(workflow, allAgents)).toEqual([]);
  });

  test('error when agent in node not found in space agents', () => {
    const nodes = [makeNode('n1', 'Code', 'unknown-agent-id')];
    const workflow = makeWorkflow(nodes, []);
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('unknown-agent-id'))).toBe(true);
  });
});
