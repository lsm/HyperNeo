import { describe, it, expect } from 'bun:test';
import {
  buildWorkflowFingerprint,
  computeWorkflowHash,
  workflowsMatchFingerprint,
} from '../../../../src/lib/space/workflows/template-hash';
import type { SpaceWorkflow } from '@hyperneo/shared';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    description: 'A test workflow',
    instructions: 'Do the thing',
    nodes: [
      { id: 'n1', name: 'Coder', agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }] },
      { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
    ],
    channels: [
      { id: 'ch1', from: 'Coder', to: 'Reviewer' },
      { id: 'ch2', from: 'Reviewer', to: 'Coder' },
    ],
    gates: [
      {
        id: 'gate-1',
        description: 'PR review gate',
        resetOnCycle: false,
      },
    ] as any,
    tags: [],
    startNodeId: 'n1',
    endNodeId: 'n2',
    createdAt: 1000,
    updatedAt: 2000,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

describe('buildWorkflowFingerprint', () => {
  it('returns sorted node names', () => {
    const wf = makeWorkflow({
      nodes: [
        { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
        { id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.nodeNames).toEqual(['Coder', 'Reviewer']);
  });

  it('returns sorted channel JSON serializations', () => {
    const wf = makeWorkflow({
      channels: [
        { id: 'ch2', from: 'Reviewer', to: 'Coder' },
        { id: 'ch1', from: 'Coder', to: 'Reviewer' },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.channels).toHaveLength(2);
    const parsed0 = JSON.parse(fp.channels[0]);
    const parsed1 = JSON.parse(fp.channels[1]);
    expect(parsed0.from).toBe('Coder');
    expect(parsed1.from).toBe('Reviewer');
  });

  it('sorts fan-out targets within a channel', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: ['QA', 'Reviewer'] }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const wf2 = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: ['Reviewer', 'QA'] }],
    });
    const fp2 = buildWorkflowFingerprint(wf2);
    expect(fp.channels).toEqual(fp2.channels);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.to).toEqual(['QA', 'Reviewer']);
  });

  it('includes channel maxCycles in serialization', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: 'Reviewer', maxCycles: 3 }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.maxCycles).toBe(3);
  });

  it('includes channel label in serialization', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: 'Reviewer', label: 'Coder → Reviewer' }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.label).toBe('Coder → Reviewer');
  });

  it('uses null for missing channel maxCycles and label', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: 'Reviewer' }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.maxCycles).toBeNull();
    expect(parsed.label).toBeNull();
  });

  it('normalizes single-target channel to arrays to strings', () => {
    const wf1 = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: 'Reviewer' }],
    });
    const wf2 = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: ['Reviewer'] }],
    });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
    const fp = buildWorkflowFingerprint(wf1);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.to).toBe('Reviewer');
  });

  it('keeps multi-target channel to as sorted array', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: ['Reviewer', 'QA'] }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.to).toEqual(['QA', 'Reviewer']);
  });

  it('uses empty string for missing description/instructions', () => {
    const wf = makeWorkflow({ description: undefined, instructions: undefined });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.description).toBe('');
    expect(fp.instructions).toBe('');
  });

  it('treats empty channels and hooks as empty arrays', () => {
    const wf = makeWorkflow({ channels: undefined, gates: undefined, hooks: undefined });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.channels).toEqual([]);
    expect(fp.hooks).toEqual([]);
  });

  it('includes workflow hooks in fingerprint', () => {
    const wf = makeWorkflow({
      hooks: [
        {
          id: 'hook-1',
          enabled: true,
          sourceNode: 'Coder',
          targetNode: 'Reviewer',
          method: 'send_message',
          validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
          authorizedCallers: [{ sourceNode: 'Coder', agentSlots: ['Coder'] }],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.hooks).toHaveLength(1);
    expect(JSON.parse(fp.hooks[0])).toEqual(wf.hooks![0]);
    expect(computeWorkflowHash(wf)).not.toBe(computeWorkflowHash(makeWorkflow()));
  });

  it('includes sorted nodePrompts for each node-agent pair', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [
            {
              agentId: 'a1',
              name: 'coder',
              customPrompt: { value: 'Write clean code' },
            },
          ],
        },
        {
          id: 'n2',
          name: 'Reviewer',
          agents: [{ agentId: 'a2', name: 'reviewer' }],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.nodePrompts).toHaveLength(2);
    expect(fp.nodePrompts[0]).toBe('Coder|coder|append|Write clean code');
    expect(fp.nodePrompts[1]).toBe('Reviewer|reviewer|append|');
  });

  it('uses empty string for missing customPrompt in nodePrompts', () => {
    const wf = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.nodePrompts[0]).toBe('Coder|coder|append|');
  });

  it('marks the slot mode as replace when replaceAgentPrompt is true', () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [
            {
              agentId: 'a1',
              name: 'coder',
              customPrompt: { value: 'Strict prompt' },
              replaceAgentPrompt: true,
            },
          ],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.nodePrompts[0]).toBe('Coder|coder|replace|Strict prompt');
  });

  it('includes per-agent resetContextPerTurn in fingerprint (drift detection)', () => {
    const base = makeWorkflow();
    const withFlag: SpaceWorkflow = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.name === 'Reviewer'
          ? { ...n, agents: n.agents.map((a) => ({ ...a, resetContextPerTurn: true })) }
          : n
      ),
    };
    expect(buildWorkflowFingerprint(base).nodeAgentResetContext).toBeUndefined();
    expect(buildWorkflowFingerprint(withFlag).nodeAgentResetContext).toEqual(['Reviewer|Reviewer']);
    expect(computeWorkflowHash(base)).not.toBe(computeWorkflowHash(withFlag));
  });

  it('keeps a stable hash for templates with no reset-enabled slot (no mass restamp)', () => {
    const noFlag = makeWorkflow();
    const alsoNoFlag = makeWorkflow({ description: 'different description' });
    expect(buildWorkflowFingerprint(noFlag).nodeAgentResetContext).toBeUndefined();
    expect(buildWorkflowFingerprint(alsoNoFlag).nodeAgentResetContext).toBeUndefined();
  });

  it('includes completionAutonomyLevel in fingerprint', () => {
    const wf = makeWorkflow({ completionAutonomyLevel: 5 });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.completionAutonomyLevel).toBe(5);
  });
});

describe('computeWorkflowHash', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = computeWorkflowHash(makeWorkflow());
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same workflow', () => {
    const wf = makeWorkflow();
    expect(computeWorkflowHash(wf)).toBe(computeWorkflowHash(wf));
  });

  it('is stable regardless of node insertion order', () => {
    const wf1 = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
        { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
      ],
    });
    const wf2 = makeWorkflow({
      nodes: [
        { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
        { id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
      ],
    });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });

  it('does NOT change when agent UUIDs differ', () => {
    const wf1 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'uuid-aaa', name: 'Coder' }] }],
    });
    const wf2 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'uuid-bbb', name: 'Coder' }] }],
    });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });

  it('does NOT change when layout coordinates differ', () => {
    const wf1 = makeWorkflow({ layout: { n1: { x: 0, y: 0 } } });
    const wf2 = makeWorkflow({ layout: { n1: { x: 999, y: 999 } } });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when a node name changes', () => {
    const wf1 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] }],
    });
    const wf2 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Developer', agents: [{ agentId: 'a1', name: 'Developer' }] }],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when description changes', () => {
    const wf1 = makeWorkflow({ description: 'Original description' });
    const wf2 = makeWorkflow({ description: 'Changed description' });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when instructions change', () => {
    const wf1 = makeWorkflow({ instructions: 'Original instructions' });
    const wf2 = makeWorkflow({ instructions: 'Changed instructions' });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when channel topology changes', () => {
    const wf1 = makeWorkflow({ channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer' }] });
    const wf2 = makeWorkflow({ channels: [{ id: 'c1', from: 'Reviewer', to: 'Coder' }] });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when channel maxCycles changes', () => {
    const wf1 = makeWorkflow({
      channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer', maxCycles: 3 }],
    });
    const wf2 = makeWorkflow({
      channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer', maxCycles: 5 }],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when channel label changes', () => {
    const wf1 = makeWorkflow({
      channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer', label: 'old label' }],
    });
    const wf2 = makeWorkflow({
      channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer', label: 'new label' }],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when a node agent customPrompt changes', () => {
    const wf1 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'Old prompt' } }],
        },
      ],
    });
    const wf2 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'New prompt' } }],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when a node agent customPrompt is added', () => {
    const wf1 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
    });
    const wf2 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'New prompt' } }],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when a slot toggles replaceAgentPrompt with the same prompt text', () => {
    const wf1 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'a1', name: 'coder', customPrompt: { value: 'Same prompt' } }],
        },
      ],
    });
    const wf2 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [
            {
              agentId: 'a1',
              name: 'coder',
              customPrompt: { value: 'Same prompt' },
              replaceAgentPrompt: true,
            },
          ],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when completionAutonomyLevel changes', () => {
    const wf1 = makeWorkflow({ completionAutonomyLevel: 3 });
    const wf2 = makeWorkflow({ completionAutonomyLevel: 4 });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('does NOT change when tags differ', () => {
    const wf1 = makeWorkflow({ tags: ['coding'] });
    const wf2 = makeWorkflow({ tags: ['coding', 'default'] });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });

  it('does NOT change when gate label/color/description differ', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          description: 'Old desc',
          label: 'Old label',
          color: '#ff0000',
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          description: 'New desc',
          label: 'New label',
          color: '#00ff00',
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });
});

describe('workflowsMatchFingerprint', () => {
  it('returns true for structurally identical workflows', () => {
    const wf1 = makeWorkflow();
    const wf2 = makeWorkflow({ id: 'wf-different-id', layout: { n1: { x: 42, y: 42 } } });
    expect(workflowsMatchFingerprint(wf1, wf2)).toBe(true);
  });

  it('returns false when node structure differs', () => {
    const wf1 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] }],
    });
    const wf2 = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'Coder' }] },
        { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'a2', name: 'Reviewer' }] },
      ],
    });
    expect(workflowsMatchFingerprint(wf1, wf2)).toBe(false);
  });

  it('returns false when an agent slot toolGuards set changes (task #866)', () => {
    const guard = {
      matcher: 'Bash',
      pattern: 'gh pr merge',
      decision: 'deny' as const,
      reason: 'no',
    };
    const wf1 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Merger', agents: [{ agentId: 'a1', name: 'Merger' }] }],
    });
    const wf2 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Merger',
          agents: [{ agentId: 'a1', name: 'Merger', toolGuards: [guard] }],
        },
      ],
    });
    expect(workflowsMatchFingerprint(wf1, wf2)).toBe(false);
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
    expect(
      (buildWorkflowFingerprint(wf1) as Record<string, unknown>).nodeAgentToolGuards
    ).toBeUndefined();
    expect((buildWorkflowFingerprint(wf2) as Record<string, unknown>).nodeAgentToolGuards).toEqual([
      `Merger|Merger|${JSON.stringify([guard])}`,
    ]);
  });

  it('returns false when an agent slot eventInterests set changes (task #907)', () => {
    const interest = {
      topicFrom: {
        source: 'primaryLink',
        pattern: 'github/{owner}/{repo}/pull_request/{number}.*',
      },
      label: 'My PR events',
    };
    const wf1 = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
    });
    const wf2 = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'a1', name: 'coder', eventInterests: [interest] }],
        },
      ],
    });
    expect(workflowsMatchFingerprint(wf1, wf2)).toBe(false);
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
    expect(
      (buildWorkflowFingerprint(wf1) as Record<string, unknown>).nodeAgentEventInterests
    ).toBeUndefined();
    expect(
      (buildWorkflowFingerprint(wf2) as Record<string, unknown>).nodeAgentEventInterests
    ).toEqual([`Coder|coder|${JSON.stringify([interest])}`]);
  });
});

describe('buildWorkflowFingerprint — handoff transitions', () => {
  it('includes node transitions in a canonical ordered shape so a change is detected as drift', () => {
    const transitions = [
      { id: 'to-reviewer', target: 'Reviewer', hookId: 'h1' },
      { id: 'to-qa', target: 'QA', label: 'QA handoff' },
    ];
    const withTransitions = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }],
          transitions,
        },
        { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
      ],
    });
    const canonical = JSON.stringify([
      {
        id: 'to-qa',
        target: 'QA',
        label: 'QA handoff',
        hookId: null,
        maxCycles: null,
      },
      {
        id: 'to-reviewer',
        target: 'Reviewer',
        label: null,
        hookId: 'h1',
        maxCycles: null,
      },
    ]);
    expect(
      (buildWorkflowFingerprint(withTransitions) as Record<string, unknown>).nodeTransitions
    ).toEqual([`Coder|${canonical}`]);
  });

  it('canonicalizes transitions so reordering does not cause false drift', () => {
    const transitionsA = [
      { id: 'a', target: 'Review' },
      { id: 'b', target: 'QA' },
    ];
    const transitionsB = [
      { id: 'b', target: 'QA' },
      { id: 'a', target: 'Review' },
    ];
    const fpA = buildWorkflowFingerprint(
      makeWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Coder',
            agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }],
            transitions: transitionsA,
          },
          { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
        ],
      })
    );
    const fpB = buildWorkflowFingerprint(
      makeWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Coder',
            agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }],
            transitions: transitionsB,
          },
          { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
        ],
      })
    );
    expect(fpA.nodeTransitions).toEqual(fpB.nodeTransitions);
  });

  it('omits nodeTransitions when no node declares transitions', () => {
    expect(
      (buildWorkflowFingerprint(makeWorkflow()) as Record<string, unknown>).nodeTransitions
    ).toBeUndefined();
  });

  it('produces a different hash when transitions differ', () => {
    const base = makeWorkflow();
    const withTransitions = makeWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coder',
          agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }],
          transitions: [{ id: 'to-reviewer', target: 'Reviewer' }],
        },
        { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
      ],
    });
    expect(computeWorkflowHash(base)).not.toBe(computeWorkflowHash(withTransitions));
  });

  it('detects single-field transition drift (e.g. hookId change)', () => {
    const node = (transitions: import('@hyperneo/shared').HandoffTransition[]) => [
      {
        id: 'n1',
        name: 'Coder',
        agents: [{ agentId: 'agent-uuid-1', name: 'Coder' }],
        transitions,
      },
      { id: 'n2', name: 'Reviewer', agents: [{ agentId: 'agent-uuid-2', name: 'Reviewer' }] },
    ];
    const withoutHook = makeWorkflow({
      nodes: node([{ id: 'to-reviewer', target: 'Reviewer' }]),
    });
    const withHook = makeWorkflow({
      nodes: node([{ id: 'to-reviewer', target: 'Reviewer', hookId: 'h1' }]),
    });
    expect(computeWorkflowHash(withoutHook)).not.toBe(computeWorkflowHash(withHook));
  });
});
