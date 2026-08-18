import { describe, test, expect } from 'bun:test';
import {
  exportAgent,
  exportWorkflow,
  exportBundle,
  validateExportedAgent,
  validateExportedWorkflow,
  validateExportBundle,
  normalizeOverride,
} from '../../../../src/lib/space/export-format.ts';
import type { SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import { MAX_NODE_HANDOFF_TRANSITIONS } from '@hyperneo/shared';

function makeAgent(overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id: 'agent-uuid-1',
    spaceId: 'space-uuid-1',
    name: 'My Coder',
    description: 'Writes code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    customPrompt: 'You are an expert coder.',
    tools: ['bash', 'read_file'],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeMinimalAgent(overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id: 'agent-uuid-2',
    spaceId: 'space-uuid-1',
    name: 'Simple Agent',
    customPrompt: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeReviewerAgent(overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id: 'agent-uuid-3',
    spaceId: 'space-uuid-1',
    name: 'Reviewer',
    customPrompt: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'workflow-uuid-1',
    spaceId: 'space-uuid-1',
    name: 'CI Workflow',
    description: 'Runs CI pipeline',
    nodes: [
      {
        id: 'node-uuid-1',
        name: 'Code step',
        agents: [{ agentId: 'agent-uuid-1', name: 'coder' }],
      },
      {
        id: 'node-uuid-2',
        name: 'Review step',
        agents: [{ agentId: 'agent-uuid-3', name: 'reviewer' }],
        instructions: 'Review carefully',
      },
      {
        id: 'node-uuid-3',
        name: 'Plan step',
        agents: [{ agentId: 'agent-uuid-2', name: 'planner' }],
      },
    ],
    startNodeId: 'node-uuid-1',
    tags: ['ci', 'test'],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('exportAgent', () => {
  test('exports all fields correctly', () => {
    const agent = makeAgent();
    const exported = exportAgent(agent);

    expect(exported.version).toBe(3);
    expect(exported.type).toBe('agent');
    expect(exported.name).toBe('My Coder');
    expect((exported as Record<string, unknown>).role).toBeUndefined();
    expect(exported.description).toBe('Writes code');
    expect(exported.model).toBe('claude-sonnet-4-6');
    expect(exported.provider).toBe('anthropic');
    expect(exported.systemPrompt).toBe('You are an expert coder.');
    expect(exported.tools).toEqual(['bash', 'read_file']);
  });

  test('strips space-specific fields (id, spaceId, createdAt, updatedAt)', () => {
    const agent = makeAgent();
    const exported = exportAgent(agent) as Record<string, unknown>;

    expect('id' in exported).toBe(false);
    expect('spaceId' in exported).toBe(false);
    expect('createdAt' in exported).toBe(false);
    expect('updatedAt' in exported).toBe(false);
  });

  test('omits undefined optional fields', () => {
    const agent = makeMinimalAgent();
    const exported = exportAgent(agent) as Record<string, unknown>;

    expect('description' in exported).toBe(false);
    expect('model' in exported).toBe(false);
    expect('provider' in exported).toBe(false);
    expect('systemPrompt' in exported).toBe(false);
    expect('tools' in exported).toBe(false);
  });

  test('exports tools as string array', () => {
    const agent = makeAgent({ tools: ['edit_file', 'bash'] });
    const exported = exportAgent(agent);
    expect(exported.tools).toEqual(['edit_file', 'bash']);
  });

  test('exports reviewer agent', () => {
    const agent = makeReviewerAgent();
    const exported = exportAgent(agent);
    expect(exported.name).toBe('Reviewer');
  });

  test('does not export toolConfig (runtime-only field)', () => {
    const agent = makeAgent({ toolConfig: { foo: true } });
    const exported = exportAgent(agent) as Record<string, unknown>;
    expect('toolConfig' in exported).toBe(false);
  });
});

describe('exportWorkflow', () => {
  test('strips workflow-level space fields', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents) as Record<string, unknown>;

    expect('id' in exported).toBe(false);
    expect('spaceId' in exported).toBe(false);
    expect('createdAt' in exported).toBe(false);
    expect('updatedAt' in exported).toBe(false);
  });

  test('strips node IDs', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    for (const node of exported.nodes) {
      expect('id' in node).toBe(false);
    }
  });

  test('strips agentId from nodes', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    for (const node of exported.nodes) {
      expect('agentId' in node).toBe(false);
      for (const a of node.agents) {
        expect('agentId' in a).toBe(false);
      }
    }
  });

  test('retains node name and instructions', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].name).toBe('Code step');
    expect(exported.nodes[1].name).toBe('Review step');
    expect(exported.nodes[2].name).toBe('Plan step');
  });

  test('remaps agentId UUID → agent name as agentRef in agents array', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].agents[0].agentRef).toBe('My Coder');
    expect(exported.nodes[1].agents[0].agentRef).toBe('Reviewer');
    expect(exported.nodes[2].agents[0].agentRef).toBe('Simple Agent');
  });

  test('falls back to UUID when agent not found', () => {
    const workflow = makeWorkflow();
    const exported = exportWorkflow(workflow, []);

    expect(exported.nodes[0].agents[0].agentRef).toBe('agent-uuid-1');
    expect(exported.nodes[1].agents[0].agentRef).toBe('agent-uuid-3');
    expect(exported.nodes[2].agents[0].agentRef).toBe('agent-uuid-2');
  });

  test('exports resetContextPerTurn on agent slots', () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Review step',
          agents: [{ agentId: 'agent-uuid-3', name: 'reviewer', resetContextPerTurn: true }],
        },
      ],
    });
    const exported = exportWorkflow(workflow, [makeReviewerAgent()]);
    expect(exported.nodes[0].agents[0].resetContextPerTurn).toBe(true);
  });

  test('exports startStep as step name', () => {
    const workflow = makeWorkflow();
    const exported = exportWorkflow(workflow, []);
    expect(exported.startNode).toBe('Code step');
  });

  test('falls back to UUID for startStep when not found', () => {
    const workflow = makeWorkflow({ startNodeId: 'node-uuid-MISSING' });
    const exported = exportWorkflow(workflow, []);
    expect(exported.startNode).toBe('node-uuid-MISSING');
  });

  test('preserves tags', () => {
    const workflow = makeWorkflow();
    const exported = exportWorkflow(workflow, []);

    expect(exported.tags).toEqual(['ci', 'test']);
    expect((exported as Record<string, unknown>).rules).toBeUndefined();
    expect((exported as Record<string, unknown>).config).toBeUndefined();
  });

  test('has version 1 and type workflow', () => {
    const exported = exportWorkflow(makeWorkflow(), []);
    expect(exported.version).toBe(3);
    expect(exported.type).toBe('workflow');
  });
});

describe('exportBundle', () => {
  test('creates bundle with correct structure', () => {
    const agents = [makeAgent()];
    const workflows = [makeWorkflow()];
    const bundle = exportBundle(agents, workflows, 'My Bundle', {
      description: 'A test bundle',
      exportedFrom: '/workspace/foo',
    });

    expect(bundle.version).toBe(3);
    expect(bundle.type).toBe('bundle');
    expect(bundle.name).toBe('My Bundle');
    expect(bundle.description).toBe('A test bundle');
    expect(bundle.exportedFrom).toBe('/workspace/foo');
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.workflows).toHaveLength(1);
    expect(typeof bundle.exportedAt).toBe('number');
    expect(bundle.exportedAt).toBeGreaterThan(0);
  });

  test('works with empty agents and workflows', () => {
    const bundle = exportBundle([], [], 'Empty Bundle');
    expect(bundle.agents).toHaveLength(0);
    expect(bundle.workflows).toHaveLength(0);
  });

  test('omits optional fields when not provided', () => {
    const bundle = exportBundle([], [], 'Minimal') as Record<string, unknown>;
    expect('description' in bundle).toBe(false);
    expect('exportedFrom' in bundle).toBe(false);
  });
});

describe('validateExportedAgent', () => {
  test('accepts a valid v1 agent', () => {
    const agent = makeAgent();
    const exported = exportAgent(agent);
    const result = validateExportedAgent(exported);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('My Coder');
      expect(result.value.version).toBe(3);
    }
  });

  test('accepts minimal valid agent', () => {
    const data = { version: 1, type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(true);
  });

  test('accepts reviewer role', () => {
    const data = { version: 1, type: 'agent', name: 'R', role: 'reviewer' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(true);
  });

  test('accepts any free-form role string', () => {
    const data = { version: 1, type: 'agent', name: 'Bot', role: 'leader' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(true);
  });

  test('accepts agent with string[] tools', () => {
    const data = { version: 1, type: 'agent', name: 'Bot', role: 'coder', tools: ['bash'] };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tools).toEqual(['bash']);
    }
  });

  test('rejects agent with object tools (old format)', () => {
    const data = { version: 1, type: 'agent', name: 'Bot', role: 'coder', tools: { bash: true } };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(false);
  });

  test('accepts v2 (current export version)', () => {
    const data = { version: 2, type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(2);
    }
  });

  test('accepts v1 (retained import support)', () => {
    const data = { version: 1, type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(1);
    }
  });

  test('rejects version > 3 with "requires newer version" message', () => {
    const data = { version: 4, type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('requires newer version');
      expect(result.error).toContain('version 3');
    }
  });

  test('rejects version 0 as invalid', () => {
    const data = { version: 0, type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid');
    }
  });

  test('rejects missing version', () => {
    const data = { type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid');
    }
  });

  test('rejects non-integer version', () => {
    const data = { version: 1.5, type: 'agent', name: 'Bot', role: 'general' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(false);
  });

  test('rejects missing name', () => {
    const data = { version: 1, type: 'agent', role: 'coder' };
    const result = validateExportedAgent(data);
    expect(result.ok).toBe(false);
  });

  test('rejects non-object input', () => {
    expect(validateExportedAgent(null).ok).toBe(false);
    expect(validateExportedAgent('string').ok).toBe(false);
    expect(validateExportedAgent(42).ok).toBe(false);
  });
});

describe('validateExportedWorkflow', () => {
  test('accepts a valid v1 workflow', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const result = validateExportedWorkflow(exported);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('CI Workflow');
      expect(result.value.version).toBe(3);
      expect(result.value.startNode).toBe('Code step');
    }
  });

  test('accepts minimal valid workflow', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Simple',
      nodes: [],
      startNode: 'first',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });

  test('accepts workflow step with agents array', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [{ agents: [{ agentRef: 'My Coder', name: 'coder' }], name: 'Step' }],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents[0].agentRef).toBe('My Coder');
    }
  });

  test('rejects step with empty agentRef in agents array', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Bad',
      nodes: [{ agents: [{ agentRef: '', name: 'slot' }], name: 'Step' }],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('rejects step missing agents array', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Bad',
      nodes: [{ name: 'Step' }],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('rejects workflow with duplicate node names', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Bad',
      nodes: [
        { agents: [{ agentRef: 'Agent A', name: 'slot' }], name: 'Step A' },
        { agents: [{ agentRef: 'Agent B', name: 'slot' }], name: 'Step A' },
      ],
      startNode: 'Step A',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('duplicate node name');
      expect(result.error).toContain('Step A');
    }
  });

  test('rejects startStep that does not match any step name', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Bad',
      nodes: [{ agents: [{ agentRef: 'Agent A', name: 'slot' }], name: 'Step A' }],
      startNode: 'nonexistent',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('startNode');
      expect(result.error).toContain('nonexistent');
    }
  });

  test('rejects version > 3 with "requires newer version"', () => {
    const data = {
      version: 4,
      type: 'workflow',
      name: 'Simple',
      nodes: [],
      startNode: 'x',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('requires newer version');
    }
  });

  test('rejects missing version', () => {
    const data = {
      type: 'workflow',
      name: 'Simple',
      nodes: [],
      startNode: 'x',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('rejects negative version', () => {
    const data = {
      version: -1,
      type: 'workflow',
      name: 'Simple',
      nodes: [],
      startNode: 'x',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });
});

describe('validateExportedWorkflow — eventInterest topic/topicFrom', () => {
  function makeWorkflowWithInterests(eventInterests: unknown, version: 1 | 2 = 2) {
    return {
      version,
      type: 'workflow',
      name: 'Interests',
      nodes: [{ agents: [{ agentRef: 'Coder', name: 'coder', eventInterests }], name: 'Step' }],
      startNode: 'Step',
      tags: [],
    };
  }

  test('accepts a static topic interest (v1)', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests([{ topic: 'github/a/b/pull_request/1.*' }], 1)
    );
    expect(result.ok).toBe(true);
  });

  test('accepts a topicFrom interest with a primaryLink source', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests([
        {
          topicFrom: {
            source: 'primaryLink',
            pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
          },
        },
      ])
    );
    expect(result.ok).toBe(true);
  });

  test('rejects a topicFrom interest in a version-1 workflow (topicFrom is v2-only)', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests(
        [
          {
            topicFrom: {
              source: 'primaryLink',
              pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
            },
          },
        ],
        1
      )
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('requires version 2');
    }
  });

  test('rejects an interest with both topic and topicFrom set', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests([
        {
          topic: 'github/a/b/pull_request/1.*',
          topicFrom: {
            source: 'primaryLink',
            pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
          },
        },
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exactly one of');
    }
  });

  test('rejects an interest with neither topic nor topicFrom set', () => {
    const result = validateExportedWorkflow(makeWorkflowWithInterests([{ label: 'x' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exactly one of');
    }
  });

  test('rejects a topicFrom with an unknown source', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests([
        {
          topicFrom: {
            source: 'taskField',
            pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
          },
        },
      ])
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a topicFrom with an empty pattern', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests([{ topicFrom: { source: 'primaryLink', pattern: '' } }])
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a topicFrom with a whitespace-only pattern (aligned with manager)', () => {
    const result = validateExportedWorkflow(
      makeWorkflowWithInterests([{ topicFrom: { source: 'primaryLink', pattern: '   ' } }])
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateExportBundle', () => {
  test('accepts a valid v1 bundle', () => {
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const workflows = [makeWorkflow()];
    const bundle = exportBundle(agents, workflows, 'Bundle');
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Bundle');
      expect(result.value.version).toBe(3);
      expect(result.value.agents).toHaveLength(3);
      expect(result.value.workflows).toHaveLength(1);
    }
  });

  test('rejects version > 1', () => {
    const bundle = { ...exportBundle([], [], 'B'), version: 5 };
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('requires newer version');
    }
  });

  test('rejects missing exportedAt', () => {
    const b = exportBundle([], [], 'B') as Record<string, unknown>;
    delete b.exportedAt;
    const result = validateExportBundle(b);
    expect(result.ok).toBe(false);
  });

  test('rejects non-object', () => {
    expect(validateExportBundle(null).ok).toBe(false);
    expect(validateExportBundle([]).ok).toBe(false);
  });

  test('rejects bundle whose nested agent has version > 3', () => {
    const bundle = exportBundle([makeAgent()], [], 'B') as Record<string, unknown>;
    const agents = bundle.agents as Array<Record<string, unknown>>;
    agents[0] = { ...agents[0], version: 4 };
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('agents[0]');
      expect(result.error).toContain('requires newer version');
    }
  });

  test('rejects bundle whose nested workflow has version > 3', () => {
    const bundle = exportBundle([], [makeWorkflow()], 'B') as Record<string, unknown>;
    const workflows = bundle.workflows as Array<Record<string, unknown>>;
    workflows[0] = { ...workflows[0], version: 4 };
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workflows[0]');
      expect(result.error).toContain('requires newer version');
    }
  });

  test('rejects bundle whose nested item version exceeds the root bundle version', () => {
    const bundle = exportBundle([], [makeWorkflow()], 'B') as Record<string, unknown>;
    bundle.version = 1;
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('exceeds bundle version 1');
    }
  });

  test('rejects bundle whose nested agent has invalid (missing) version', () => {
    const bundle = exportBundle([makeAgent()], [], 'B') as Record<string, unknown>;
    const agents = bundle.agents as Array<Record<string, unknown>>;
    const { version: _v, ...agentWithoutVersion } = agents[0];
    agents[0] = agentWithoutVersion;
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('agents[0]');
      expect(result.error).toContain('invalid');
    }
  });
});

describe('round-trip: export → JSON → validate', () => {
  test('agent round-trip', () => {
    const agent = makeAgent();
    const exported = exportAgent(agent);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedAgent(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe(agent.name);
      expect((result.value as Record<string, unknown>).role).toBeUndefined();
      expect(result.value.model).toBe(agent.model);
      expect(result.value.tools).toEqual(['bash', 'read_file']);
    }
  });

  test('reviewer agent round-trip', () => {
    const agent = makeReviewerAgent();
    const exported = exportAgent(agent);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedAgent(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).role).toBeUndefined();
      expect(result.value.name).toBe('Reviewer');
    }
  });

  test('workflow round-trip', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe(workflow.name);
      expect(result.value.nodes).toHaveLength(3);
      expect(result.value.nodes[0].agents[0].agentRef).toBe('My Coder');
      expect(result.value.nodes[1].agents[0].agentRef).toBe('Reviewer');
      expect(result.value.nodes[2].agents[0].agentRef).toBe('Simple Agent');
      expect(result.value.startNode).toBe('Code step');
    }
  });

  test('topicFrom interest round-trips through export/import (v2)', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-topicfrom',
      spaceId: 'space-uuid-1',
      name: 'Dynamic Topic Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Code step',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              eventInterests: [
                {
                  topicFrom: {
                    source: 'primaryLink',
                    pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
                  },
                },
              ],
            },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agents = [makeAgent()];

    const exported = exportWorkflow(workflow, agents);
    expect(exported.version).toBe(3);
    const result = validateExportedWorkflow(JSON.parse(JSON.stringify(exported)) as unknown);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(3);
      expect(result.value.nodes[0].agents[0].eventInterests?.[0]?.topicFrom).toEqual({
        source: 'primaryLink',
        pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
      });
    }

    const bundle = exportBundle(agents, [workflow], 'TopicFrom Bundle');
    const bundleResult = validateExportBundle(JSON.parse(JSON.stringify(bundle)) as unknown);
    expect(bundleResult.ok).toBe(true);
    if (bundleResult.ok) {
      expect(bundleResult.value.version).toBe(3);
      expect(
        bundleResult.value.workflows[0].nodes[0].agents[0].eventInterests?.[0]?.topicFrom
      ).toBeDefined();
    }
  });

  test('bundle round-trip', () => {
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const workflows = [makeWorkflow()];
    const bundle = exportBundle(agents, workflows, 'My Bundle', {
      description: 'Test',
      exportedFrom: '/workspace',
    });
    const json = JSON.stringify(bundle);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportBundle(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agents).toHaveLength(3);
      expect(result.value.workflows).toHaveLength(1);
      expect(result.value.exportedFrom).toBe('/workspace');
    }
  });
});

describe('export format correctness', () => {
  test('node UUIDs do not appear in serialized JSON', () => {
    const workflow = makeWorkflow();
    const exported = exportWorkflow(workflow, []);
    const json = JSON.stringify(exported);

    expect(json).not.toContain('node-uuid-1');
    expect(json).not.toContain('node-uuid-2');
    expect(json).not.toContain('node-uuid-3');

    expect((exported as Record<string, unknown>).rules).toBeUndefined();
    expect((exported as Record<string, unknown>).config).toBeUndefined();
  });

  test('workflow round-trip produces valid export', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes).toHaveLength(3);
      expect(result.value.startNode).toBe('Code step');
    }
  });

  test('agent UUIDs do not appear in JSON after export', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);

    expect(json).not.toContain('agent-uuid-1');
    expect(json).not.toContain('agent-uuid-2');
    expect(json).not.toContain('agent-uuid-3');
    expect(json).toContain('My Coder');
    expect(json).toContain('Reviewer');
    expect(json).toContain('Simple Agent');
  });
});

describe('exportWorkflow — multi-agent nodes', () => {
  function makeMultiAgentWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
    return {
      id: 'workflow-uuid-ma',
      spaceId: 'space-uuid-1',
      name: 'Multi-Agent Workflow',
      description: 'Tests multi-agent nodes',
      nodes: [
        {
          id: 'node-uuid-1',
          name: 'Parallel code+review',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'Write the feature' },
            },
            { agentId: 'agent-uuid-3', name: 'reviewer' },
          ],
        },
        {
          id: 'node-uuid-2',
          name: 'Single plan step',
          agents: [{ agentId: 'agent-uuid-2', name: 'planner' }],
        },
      ],
      channels: [
        {
          from: 'coder',
          to: 'reviewer',
        },
      ],
      startNodeId: 'node-uuid-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
      ...overrides,
    };
  }

  test('exports multi-agent node as agents array', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    const node = exported.nodes[0];
    expect(node.agents).toHaveLength(2);
    expect((node as Record<string, unknown>).agentRef).toBeUndefined();
  });

  test('resolves agentId UUIDs to agent names in agents array', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    const node = exported.nodes[0];
    expect(node.agents![0].agentRef).toBe('My Coder');
    expect(node.agents![1].agentRef).toBe('Reviewer');
  });

  test('preserves per-agent customPrompt in agents array (exported as systemPrompt)', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].agents![0].systemPrompt).toEqual({ value: 'Write the feature' });
    expect(exported.nodes[0].agents![0].instructions).toBeUndefined();
    expect(exported.nodes[0].agents![1].systemPrompt).toBeUndefined();
  });

  test('preserves replaceAgentPrompt in agents array through export and JSON round-trip', () => {
    const workflow = makeMultiAgentWorkflow({
      nodes: [
        {
          id: 'node-uuid-1',
          name: 'Parallel code+review',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'Write the feature' },
              replaceAgentPrompt: true,
            },
            { agentId: 'agent-uuid-3', name: 'reviewer' },
          ],
        },
        {
          id: 'node-uuid-2',
          name: 'Single plan step',
          agents: [{ agentId: 'agent-uuid-2', name: 'planner' }],
        },
      ],
    });
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].agents![0].replaceAgentPrompt).toBe(true);
    expect(exported.nodes[0].agents![1].replaceAgentPrompt).toBeUndefined();

    const parsed = JSON.parse(JSON.stringify(exported)) as unknown;
    const result = validateExportedWorkflow(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents[0].replaceAgentPrompt).toBe(true);
      expect(result.value.nodes[0].agents[1].replaceAgentPrompt).toBeUndefined();
    }
  });

  test('falls back to UUID for unresolved agent in multi-agent node', () => {
    const workflow = makeMultiAgentWorkflow();
    const exported = exportWorkflow(workflow, []);

    expect(exported.nodes[0].agents![0].agentRef).toBe('agent-uuid-1');
    expect(exported.nodes[0].agents![1].agentRef).toBe('agent-uuid-3');
  });

  test('exports channels as-is (role strings, not UUIDs)', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.channels).toHaveLength(1);
    expect(exported.channels![0].from).toBe('coder');
    expect(exported.channels![0].to).toBe('reviewer');
  });

  test('omits channels at node level when channels are workflow-level', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].channels).toBeUndefined();
    expect(exported.nodes[1].channels).toBeUndefined();
  });

  test('single-agent node with channels exports channels', () => {
    const workflow = makeMultiAgentWorkflow({
      nodes: [
        {
          id: 'node-uuid-1',
          name: 'Solo with channel',
          agents: [{ agentId: 'agent-uuid-1', name: 'coder' }],
        },
      ],
      channels: [{ id: 'ch-1', from: 'coder', to: '*' }],
      startNodeId: 'node-uuid-1',
    });
    const agents = [makeAgent()];
    const exported = exportWorkflow(workflow, agents);

    const node = exported.nodes[0];
    expect(node.agents).toHaveLength(1);
    expect(node.agents[0].agentRef).toBe('My Coder');
    expect(exported.channels).toHaveLength(1);
    expect(exported.channels![0].from).toBe('coder');
    expect(exported.channels![0].to).toBe('*');
    expect('direction' in (exported.channels![0] ?? {})).toBe(false);
  });

  test('export produces empty agents array when node has empty agents', () => {
    const workflow = makeMultiAgentWorkflow({
      nodes: [{ id: 'node-uuid-1', name: 'Empty step', agents: [] } as any],
      startNodeId: 'node-uuid-1',
    });
    const exported = exportWorkflow(workflow, []);

    const node = exported.nodes[0];
    expect(node.agents).toEqual([]);
  });

  test('single-agent node exports as agents array with one entry', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    const node = exported.nodes[1];
    expect(node.agents).toHaveLength(1);
    expect(node.agents[0].agentRef).toBe('Simple Agent');
    expect((node as Record<string, unknown>).agentRef).toBeUndefined();
  });

  test('agent UUIDs do not appear in multi-agent exported JSON', () => {
    const workflow = makeMultiAgentWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);

    expect(json).not.toContain('agent-uuid-1');
    expect(json).not.toContain('agent-uuid-3');
    expect(json).toContain('My Coder');
    expect(json).toContain('Reviewer');
  });
});

describe('validateExportedWorkflow — multi-agent and channels', () => {
  test('accepts step with agents array', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            {
              agentRef: 'My Coder',
              name: 'coder',
              instructions: { mode: 'override', value: 'Code it' },
            },
            { agentRef: 'Reviewer', name: 'reviewer' },
          ],
          name: 'Parallel Step',
        },
      ],
      startNode: 'Parallel Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents).toHaveLength(2);
      expect(result.value.nodes[0].agents![0].agentRef).toBe('My Coder');
      expect(result.value.nodes[0].agents![0].instructions).toEqual({ value: 'Code it' });
    }
  });

  test('accepts step with channels', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'Coder', name: 'coder' },
            { agentRef: 'Reviewer', name: 'reviewer' },
          ],
          name: 'Step',
        },
      ],
      channels: [{ from: 'coder', to: 'reviewer' }],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channels).toHaveLength(1);
      expect(result.value.channels![0].from).toBe('coder');
    }
  });

  test('accepts channel with array `to` field (fan-out topology)', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'Hub', name: 'hub' },
            { agentRef: 'Spoke1', name: 'spoke1' },
            { agentRef: 'Spoke2', name: 'spoke2' },
          ],
          name: 'Fan-out',
        },
      ],
      channels: [{ from: 'hub', to: ['spoke1', 'spoke2'] }],
      startNode: 'Fan-out',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channels![0].to).toEqual(['spoke1', 'spoke2']);
    }
  });

  test('rejects step with empty agents array', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Bad',
      nodes: [{ agents: [], name: 'Empty agents step' }],
      startNode: 'Empty agents step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('rejects agent entry with empty agentRef in agents array', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'Bad',
      nodes: [
        {
          agents: [{ agentRef: '' }],
          name: 'Step',
        },
      ],
      transitions: [],
      startNode: 'Step',
      rules: [],
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('accepts agents array entry with instructions override', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            {
              agentRef: 'My Coder',
              name: 'coder',
              instructions: { mode: 'override', value: 'Write minimal code.' },
            },
          ],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents![0].instructions).toEqual({
        value: 'Write minimal code.',
      });
    }
  });

  test('accepts agents array entry with systemPrompt override', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            {
              agentRef: 'My Coder',
              name: 'coder',
              systemPrompt: { mode: 'override', value: 'You are a strict code reviewer.' },
            },
          ],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents![0].systemPrompt).toEqual({
        value: 'You are a strict code reviewer.',
      });
    }
  });

  test('backward compat: accepts agents array entries without model/systemPrompt (old export format)', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'My Coder', name: 'coder' },
            { agentRef: 'Reviewer', name: 'reviewer' },
          ],
          name: 'Step',
        },
      ],
      transitions: [],
      startNode: 'Step',
      rules: [],
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const agents = result.value.nodes[0].agents!;
      expect(agents[0].model).toBeUndefined();
      expect(agents[0].systemPrompt).toBeUndefined();
      expect(agents[1].model).toBeUndefined();
      expect(agents[1].systemPrompt).toBeUndefined();
    }
  });

  test('accepts agents with both systemPrompt and instructions overrides', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            {
              agentRef: 'My Coder',
              name: 'coder',
              systemPrompt: { mode: 'override', value: 'Write minimal code.' },
              instructions: { mode: 'expand', value: 'Focus on tests.' },
            },
            {
              agentRef: 'Reviewer',
              name: 'reviewer',
              systemPrompt: { mode: 'override', value: 'Review briefly.' },
            },
          ],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const agents = result.value.nodes[0].agents!;
      expect(agents[0].systemPrompt).toEqual({ value: 'Write minimal code.' });
      expect(agents[0].instructions).toEqual({ value: 'Focus on tests.' });
      expect(agents[1].systemPrompt).toEqual({ value: 'Review briefly.' });
    }
  });
});

describe('round-trip: multi-agent + channels', () => {
  function makeMultiAgentWorkflowForRoundTrip(): SpaceWorkflow {
    return {
      id: 'wf-1',
      spaceId: 'space-1',
      name: 'Collab Workflow',
      description: 'Coder and reviewer in parallel',
      nodes: [
        {
          id: 'node-1',
          name: 'Code and Review',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'Implement the feature' },
            },
            {
              agentId: 'agent-uuid-3',
              name: 'reviewer',
              customPrompt: { value: 'Review the code' },
            },
          ],
        },
        {
          id: 'node-2',
          name: 'Final Plan',
          agents: [{ agentId: 'agent-uuid-2', name: 'planner' }],
        },
      ],
      channels: [{ id: 'ch-1', from: 'coder', to: 'reviewer', label: 'feedback' }],
      startNodeId: 'node-1',
      tags: ['collab'],
      createdAt: 1000,
      updatedAt: 2000,
    };
  }

  test('multi-agent node round-trip preserves agents array and channels', () => {
    const workflow = makeMultiAgentWorkflowForRoundTrip();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const node = result.value.nodes[0];
      expect(node.agents).toHaveLength(2);
      expect(node.agents![0].agentRef).toBe('My Coder');
      expect(node.agents![0].systemPrompt).toEqual({ value: 'Implement the feature' });
      expect(node.agents![1].agentRef).toBe('Reviewer');
      expect(node.agents![1].systemPrompt).toEqual({ value: 'Review the code' });
      expect((node as Record<string, unknown>).agentRef).toBeUndefined();
      expect(exported.channels).toHaveLength(1);
      expect(exported.channels![0].from).toBe('coder');
      expect(exported.channels![0].to).toBe('reviewer');
      expect(exported.channels![0].label).toBe('feedback');
      expect('instructions' in node).toBe(false);
    }
  });

  test('single-agent node in mixed workflow round-trips as agents array', () => {
    const workflow = makeMultiAgentWorkflowForRoundTrip();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const node = result.value.nodes[1];
      expect(node.agents).toHaveLength(1);
      expect(node.agents![0].agentRef).toBe('Simple Agent');
      expect((node as Record<string, unknown>).agentRef).toBeUndefined();
      expect((node as Record<string, unknown>).channels).toBeUndefined();
    }
  });

  test('no UUIDs in multi-agent exported JSON', () => {
    const workflow = makeMultiAgentWorkflowForRoundTrip();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);

    expect(json).not.toContain('agent-uuid-1');
    expect(json).not.toContain('agent-uuid-2');
    expect(json).not.toContain('agent-uuid-3');
    expect(json).not.toContain('node-1');
    expect(json).not.toContain('node-2');
    expect(json).toContain('My Coder');
    expect(json).toContain('Reviewer');
    expect(json).toContain('Simple Agent');
  });

  test('exported agents[] entries include role field', () => {
    const workflow = makeMultiAgentWorkflowForRoundTrip();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    const node = exported.nodes[0];
    expect(node.agents![0].name).toBe('coder');
    expect(node.agents![1].name).toBe('reviewer');
  });

  test('role field survives export → JSON → validate round-trip', () => {
    const workflow = makeMultiAgentWorkflowForRoundTrip();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents![0].name).toBe('coder');
      expect(result.value.nodes[0].agents![1].name).toBe('reviewer');
    }
  });

  test('exports per-slot customPrompt override as systemPrompt in exported format', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-1',
      spaceId: 'space-1',
      name: 'Prompt Override',
      nodes: [
        {
          id: 'node-1',
          name: 'Step',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'Always write tests first.' },
            },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agents = [makeAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].agents![0].systemPrompt).toEqual({
      value: 'Always write tests first.',
    });
    expect(exported.nodes[0].agents![0].instructions).toBeUndefined();
  });

  test('exports per-slot customPrompt (no instructions field in new API)', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-1',
      spaceId: 'space-1',
      name: 'Prompt Override',
      nodes: [
        {
          id: 'node-1',
          name: 'Step',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'Focus on the auth module only.' },
            },
            {
              agentId: 'agent-uuid-3',
              name: 'reviewer',
            },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agents = [makeAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].agents![0].systemPrompt).toEqual({
      value: 'Focus on the auth module only.',
    });
    expect(exported.nodes[0].agents![0].instructions).toBeUndefined();
    expect(exported.nodes[0].agents![1].systemPrompt).toBeUndefined();
  });

  test('omits systemPrompt when not set (clean export)', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-1',
      spaceId: 'space-1',
      name: 'Basic Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Step',
          agents: [
            { agentId: 'agent-uuid-1', name: 'coder' },
            { agentId: 'agent-uuid-3', name: 'reviewer' },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agents = [makeAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    const entry0 = exported.nodes[0].agents![0] as Record<string, unknown>;
    const entry1 = exported.nodes[0].agents![1] as Record<string, unknown>;
    expect('systemPrompt' in entry0).toBe(false);
    expect('instructions' in entry0).toBe(false);
    expect('systemPrompt' in entry1).toBe(false);
    expect('instructions' in entry1).toBe(false);
  });

  test('customPrompt slot override survives export → JSON → validate round-trip', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-overrides',
      spaceId: 'space-1',
      name: 'Override Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Overriding Step',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'You are a strict reviewer.' },
            },
            {
              agentId: 'agent-uuid-3',
              name: 'reviewer',
            },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agents = [makeAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    const exportedNode = exported.nodes[0];
    expect(exportedNode.agents![0].systemPrompt).toEqual({ value: 'You are a strict reviewer.' });
    expect(exportedNode.agents![0].instructions).toBeUndefined();
    expect(exportedNode.agents![1].systemPrompt).toBeUndefined();

    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const node = result.value.nodes[0];
      expect(node.agents![0].agentRef).toBe('My Coder');
      expect(node.agents![0].name).toBe('coder');
      expect(node.agents![0].systemPrompt).toEqual({ value: 'You are a strict reviewer.' });
      expect(node.agents![1].agentRef).toBe('Reviewer');
      expect(node.agents![1].name).toBe('reviewer');
      expect(node.agents![1].systemPrompt).toBeUndefined();
    }
  });

  test('customPrompt slot override (no separate instructions field in new API)', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-instructions',
      spaceId: 'space-1',
      name: 'Prompt Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Step',
          agents: [
            {
              agentId: 'agent-uuid-1',
              name: 'coder',
              customPrompt: { value: 'Focus on the auth module only.' },
            },
            {
              agentId: 'agent-uuid-3',
              name: 'reviewer',
            },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agents = [makeAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents![0].systemPrompt).toEqual({
        value: 'Focus on the auth module only.',
      });
      expect(result.value.nodes[0].agents![0].instructions).toBeUndefined();
      expect(result.value.nodes[0].agents![1].systemPrompt).toBeUndefined();
    }
  });
});

describe('ExportedWorkflowChannel — export and validation', () => {
  function makeWorkflowWithChannelId(): SpaceWorkflow {
    return {
      id: 'wf-ch',
      spaceId: 'space-1',
      name: 'Channel Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Code and Review',
          agents: [
            { agentId: 'agent-uuid-1', name: 'coder' },
            { agentId: 'agent-uuid-3', name: 'reviewer' },
          ],
        },
      ],
      startNodeId: 'node-1',
      tags: [],
      channels: [
        {
          id: 'ch-uuid-1',
          from: 'coder',
          to: 'reviewer',
          label: 'feedback',
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    };
  }

  test('exportWorkflow strips channel id', () => {
    const workflow = makeWorkflowWithChannelId();
    const exported = exportWorkflow(workflow, [makeAgent(), makeReviewerAgent()]);

    expect(exported.channels).toHaveLength(1);
    const ch = exported.channels![0] as Record<string, unknown>;
    expect('id' in ch).toBe(false);
  });

  test('exportWorkflow preserves channel fields except id', () => {
    const workflow = makeWorkflowWithChannelId();
    const exported = exportWorkflow(workflow, [makeAgent(), makeReviewerAgent()]);

    const ch = exported.channels![0];
    expect(ch.from).toBe('coder');
    expect(ch.to).toBe('reviewer');
    expect(ch.label).toBe('feedback');
  });

  test('exportWorkflow strips id from channel with gate', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-gate',
      spaceId: 'space-1',
      name: 'Gated Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Work',
          agents: [
            { agentId: 'agent-uuid-1', name: 'coder' },
            { agentId: 'agent-uuid-3', name: 'reviewer' },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'node-1',
      rules: [],
      tags: [],
      channels: [
        {
          id: 'ch-gate-uuid',
          from: 'coder',
          to: 'reviewer',
          gateId: 'approval-gate',
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const exported = exportWorkflow(workflow, [makeAgent(), makeReviewerAgent()]);

    const ch = exported.channels![0] as Record<string, unknown>;
    expect('id' in ch).toBe(false);
    expect(ch.gate).toBeUndefined();
  });

  test('exportWorkflow strips id from channel with isCyclic', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-cyclic',
      spaceId: 'space-1',
      name: 'Cyclic Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Loop',
          agents: [
            { agentId: 'agent-uuid-1', name: 'coder' },
            { agentId: 'agent-uuid-3', name: 'reviewer' },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'node-1',
      rules: [],
      tags: [],
      channels: [
        {
          id: 'ch-cyclic-uuid',
          from: 'coder',
          to: 'reviewer',
          maxCycles: 3,
        },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const exported = exportWorkflow(workflow, [makeAgent(), makeReviewerAgent()]);

    const ch = exported.channels![0] as Record<string, unknown>;
    expect('id' in ch).toBe(false);
    expect(ch.maxCycles).toBe(3);
  });

  test('channel id does not appear in exported JSON', () => {
    const workflow = makeWorkflowWithChannelId();
    const exported = exportWorkflow(workflow, [makeAgent(), makeReviewerAgent()]);
    const json = JSON.stringify(exported);

    expect(json).not.toContain('ch-uuid-1');
  });

  test('validateExportedWorkflow accepts channels with valid slot name references', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'Coder', name: 'coder' },
            { agentRef: 'Reviewer', name: 'reviewer' },
          ],
          name: 'Collab',
        },
      ],
      transitions: [],
      startNode: 'Collab',
      rules: [],
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });

  test('validateExportedWorkflow accepts channels referencing node name (fan-out)', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [{ agentRef: 'Coder', name: 'coder' }],
          name: 'Code',
        },
        {
          agents: [{ agentRef: 'Reviewer', name: 'reviewer' }],
          name: 'Review',
        },
      ],
      transitions: [{ fromNode: 'Code', toNode: 'Review' }],
      startNode: 'Code',
      rules: [],
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });

  test('validateExportedWorkflow accepts wildcard * references', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [{ agentRef: 'Coder', name: 'coder' }],
          name: 'Work',
        },
      ],
      transitions: [],
      startNode: 'Work',
      rules: [],
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });

  test('validateExportedWorkflow rejects channel with unknown from reference', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [{ agents: [{ agentRef: 'Coder', name: 'coder' }], name: 'Collab' }],
      channels: [{ from: '', to: 'coder' }],
      startNode: 'Collab',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('validateExportedWorkflow accepts valid channel from → to', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'Coder', name: 'coder' },
            { agentRef: 'Reviewer', name: 'reviewer' },
          ],
          name: 'Collab',
        },
      ],
      channels: [{ from: 'coder', to: 'reviewer' }],
      startNode: 'Collab',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });

  test('validateExportedWorkflow accepts fan-out channel with array to', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'Hub', name: 'hub' },
            { agentRef: 'Spoke1', name: 'spoke1' },
          ],
          name: 'Fan-out',
        },
      ],
      channels: [{ from: 'hub', to: ['spoke1'] }],
      startNode: 'Fan-out',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });

  test('validateExportedWorkflow rejects channel id present in input (schema excludes id)', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            { agentRef: 'Coder', name: 'coder' },
            { agentRef: 'Reviewer', name: 'reviewer' },
          ],
          name: 'Step',
        },
      ],
      channels: [{ id: 'some-id', from: 'coder', to: 'reviewer' }],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ch = result.value.channels![0] as Record<string, unknown>;
      expect('id' in ch).toBe(false);
    }
  });

  test('round-trip: export strips channel id, validate passes', () => {
    const workflow = makeWorkflowWithChannelId();
    const agents = [makeAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channels).toHaveLength(1);
      const ch = result.value.channels![0] as Record<string, unknown>;
      expect('id' in ch).toBe(false);
      expect(ch.from).toBe('coder');
      expect(ch.to).toBe('reviewer');
    }
  });
});

describe('normalizeOverride', () => {
  test('returns undefined for undefined input', () => {
    expect(normalizeOverride(undefined)).toBeUndefined();
  });

  test('converts plain string to { value }', () => {
    const result = normalizeOverride('Be helpful.');
    expect(result).toEqual({ value: 'Be helpful.' });
  });

  test('passes through { value } object as-is', () => {
    const override = { value: 'You are strict.' };
    const result = normalizeOverride(override);
    expect(result).toBe(override);
  });
});

describe('validateExportedWorkflow — legacy plain-string overrides', () => {
  test('accepts node agent with plain string systemPrompt', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [{ agentRef: 'Coder', name: 'coder', systemPrompt: 'You are helpful' }],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents[0].systemPrompt).toBe('You are helpful');
    }
  });

  test('accepts node agent with plain string instructions', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [{ agentRef: 'Coder', name: 'coder', instructions: 'Focus on tests.' }],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].agents[0].instructions).toBe('Focus on tests.');
    }
  });

  test('accepts both plain strings and { mode, value } objects in the same node', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [
            {
              agentRef: 'Coder',
              name: 'coder',
              systemPrompt: 'You are a coder',
              instructions: { mode: 'override', value: 'Write tests' },
            },
            {
              agentRef: 'Reviewer',
              name: 'reviewer',
              systemPrompt: { mode: 'expand', value: 'Extra context' },
              instructions: 'Review thoroughly',
            },
          ],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const agents = result.value.nodes[0].agents;
      expect(agents[0].systemPrompt).toBe('You are a coder');
      expect(agents[0].instructions).toEqual({ value: 'Write tests' });
      expect(agents[1].systemPrompt).toEqual({ value: 'Extra context' });
      expect(agents[1].instructions).toBe('Review thoroughly');
    }
  });

  test('rejects empty string for systemPrompt (min 1)', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [{ agentRef: 'Coder', name: 'coder', systemPrompt: '' }],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('rejects empty string for instructions (min 1)', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          agents: [{ agentRef: 'Coder', name: 'coder', instructions: '' }],
          name: 'Step',
        },
      ],
      startNode: 'Step',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
  });

  test('workflow without per-slot overrides round-trips cleanly', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const node of result.value.nodes) {
        for (const agent of node.agents) {
          expect(agent.systemPrompt).toBeUndefined();
          expect(agent.instructions).toBeUndefined();
        }
      }
    }
  });
});

describe('exportWorkflow — endNode', () => {
  test('exports endNode when endNodeId is set (map UUID to node name)', () => {
    const workflow = makeWorkflow({
      endNodeId: 'node-uuid-3',
    });
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.endNode).toBe('Plan step');
  });

  test('omits endNode when endNodeId is not set', () => {
    const workflow = makeWorkflow();
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.endNode).toBeUndefined();
  });

  test('falls back to UUID when endNode name not found', () => {
    const workflow = makeWorkflow({
      endNodeId: 'node-uuid-missing',
    });
    const exported = exportWorkflow(workflow, []);

    expect(exported.endNode).toBe('node-uuid-missing');
  });

  test('endNode round-trip: export → JSON → validate → verify endNode matches node name', () => {
    const workflow = makeWorkflow({
      endNodeId: 'node-uuid-3',
    });
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as unknown;
    const result = validateExportedWorkflow(parsed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.endNode).toBe('Plan step');
    }
  });

  test('rejects endNode that does not reference a known node name', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [{ agents: [{ agentRef: 'A', name: 'a' }], name: 'Step' }],
      startNode: 'Step',
      endNode: 'NonExistentNode',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('endNode');
      expect(result.error).toContain('NonExistentNode');
    }
  });

  test('accepts endNode when nodes array is empty', () => {
    const data = {
      version: 1,
      type: 'workflow',
      name: 'W',
      nodes: [],
      startNode: 'first',
      endNode: 'NonExistentNode',
      tags: [],
    };
    const result = validateExportedWorkflow(data);
    expect(result.ok).toBe(true);
  });
});

describe('exportWorkflow — disabled', () => {
  test('exports disabled when true', () => {
    const workflow = makeWorkflow({ disabled: true });
    const exported = exportWorkflow(workflow, []);
    expect(exported.disabled).toBe(true);
  });

  test('omits disabled when false', () => {
    const workflow = makeWorkflow({ disabled: false });
    const exported = exportWorkflow(workflow, []);
    expect(exported.disabled).toBeUndefined();
  });

  test('omits disabled when undefined', () => {
    const workflow = makeWorkflow();
    const exported = exportWorkflow(workflow, []);
    expect(exported.disabled).toBeUndefined();
  });
});

describe('exportWorkflow — handoff transitions', () => {
  test('exports node transitions and omits them when absent', () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: 'node-uuid-1',
          name: 'Code step',
          agents: [{ agentId: 'agent-uuid-1', name: 'coder' }],
          transitions: [
            { id: 'to-review', target: 'Review step', maxCycles: 3 },
            { id: 'broadcast', target: '*' },
          ],
        },
        {
          id: 'node-uuid-2',
          name: 'Review step',
          agents: [{ agentId: 'agent-uuid-3', name: 'reviewer' }],
        },
      ],
    });
    const agents = [makeAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);

    expect(exported.nodes[0].transitions).toEqual([
      { id: 'to-review', target: 'Review step', maxCycles: 3 },
      { id: 'broadcast', target: '*' },
    ]);
    expect(exported.nodes[1].transitions).toBeUndefined();
  });

  test('round-trips transitions through export → validate', () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: 'node-uuid-1',
          name: 'Code step',
          agents: [{ agentId: 'agent-uuid-1', name: 'coder' }],
          transitions: [{ id: 'to-review', target: 'Review step', label: 'hand off' }],
        },
        {
          id: 'node-uuid-2',
          name: 'Review step',
          agents: [{ agentId: 'agent-uuid-3', name: 'reviewer' }],
        },
        {
          id: 'node-uuid-3',
          name: 'Plan step',
          agents: [{ agentId: 'agent-uuid-2', name: 'planner' }],
        },
      ],
    });
    const agents = [makeAgent(), makeMinimalAgent(), makeReviewerAgent()];
    const exported = exportWorkflow(workflow, agents);
    const result = validateExportedWorkflow(exported);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[0].transitions).toEqual([
        { id: 'to-review', target: 'Review step', label: 'hand off' },
      ]);
    }
  });
});

describe('validateExportedWorkflow — handoff transitions', () => {
  function wfWithTransitions(
    transitions: Array<Record<string, unknown>>,
    hooks?: Array<Record<string, unknown>>
  ) {
    return {
      version: 3,
      type: 'workflow',
      name: 'W',
      nodes: [
        { name: 'Code', agents: [{ agentRef: 'coder', name: 'coder' }], transitions },
        { name: 'Review', agents: [{ agentRef: 'reviewer', name: 'reviewer' }] },
      ],
      startNode: 'Code',
      tags: [],
      ...(hooks ? { hooks } : {}),
    };
  }

  test('accepts valid transitions including broadcast and agent-slot targets', () => {
    const result = validateExportedWorkflow(
      wfWithTransitions([
        { id: 'a', target: 'Review' },
        { id: 'b', target: 'reviewer' },
        { id: 'c', target: '*' },
      ])
    );
    expect(result.ok).toBe(true);
  });

  test('rejects a transition target that references no known node/agent', () => {
    const result = validateExportedWorkflow(wfWithTransitions([{ id: 'a', target: 'Ghost' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('does not reference a known node name');
  });

  test('rejects an ambiguous target whose name matches multiple destinations', () => {
    const result = validateExportedWorkflow({
      version: 3,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          name: 'A',
          agents: [{ agentRef: 'coder', name: 'shared' }],
          transitions: [{ id: 't', target: 'shared' }],
        },
        { name: 'B', agents: [{ agentRef: 'coder', name: 'shared' }] },
      ],
      startNode: 'A',
      tags: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ambiguous');
  });

  test('rejects a duplicate transition id within a node', () => {
    const result = validateExportedWorkflow(
      wfWithTransitions([
        { id: 'dup', target: 'Review' },
        { id: 'dup', target: 'reviewer' },
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('duplicate transition id "dup"');
  });

  test('rejects a duplicate transition target within a node', () => {
    const result = validateExportedWorkflow(
      wfWithTransitions([
        { id: 'a', target: 'Review' },
        { id: 'b', target: 'Review' },
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('duplicate transition target "Review"');
  });

  test('rejects a hookId that references no known hook', () => {
    const result = validateExportedWorkflow(
      wfWithTransitions([{ id: 'a', target: 'Review', hookId: 'ghost' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain('hookId "ghost" does not reference a known hook');
  });

  test('trims and rejects whitespace-only id/target (mirrors eventInterestTopicFrom)', () => {
    const idResult = validateExportedWorkflow(wfWithTransitions([{ id: '   ', target: 'Review' }]));
    expect(idResult.ok).toBe(false);
    const targetResult = validateExportedWorkflow(wfWithTransitions([{ id: 'a', target: '   ' }]));
    expect(targetResult.ok).toBe(false);
  });

  test('rejects more than MAX_NODE_HANDOFF_TRANSITIONS transitions on a node', () => {
    const tooMany = Array.from({ length: MAX_NODE_HANDOFF_TRANSITIONS + 1 }, (_, i) => ({
      id: `t${i}`,
      target: 'Review',
    }));
    const result = validateExportedWorkflow(wfWithTransitions(tooMany));
    expect(result.ok).toBe(false);
  });
});

describe('export format — v3 version gating (transitions)', () => {
  function v2WorkflowWithTransitions() {
    return {
      version: 2,
      type: 'workflow',
      name: 'W',
      nodes: [
        {
          name: 'Code',
          agents: [{ agentRef: 'coder', name: 'coder' }],
          transitions: [{ id: 't', target: 'Review' }],
        },
        { name: 'Review', agents: [{ agentRef: 'reviewer', name: 'reviewer' }] },
      ],
      startNode: 'Code',
      tags: [],
    };
  }

  test('rejects a v2 workflow carrying transitions', () => {
    const result = validateExportedWorkflow(v2WorkflowWithTransitions());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('require version 3');
  });
});
