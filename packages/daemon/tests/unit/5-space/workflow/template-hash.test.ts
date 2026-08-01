/**
 * Unit tests for template-hash utility.
 *
 * Verifies that:
 * - buildWorkflowFingerprint produces deterministic, order-independent output
 * - computeWorkflowHash returns a stable hex string for identical workflows
 * - workflowsMatchFingerprint returns true/false correctly
 * - Layout coordinates and agent UUIDs do NOT affect the hash
 * - Gate poll fields are included in the fingerprint
 * - Channel gateId and maxCycles are included in the fingerprint
 */

import { describe, it, expect } from 'bun:test';
import {
  buildWorkflowFingerprint,
  computeWorkflowHash,
  workflowsMatchFingerprint,
} from '../../../../src/lib/space/workflows/template-hash';
import type { SpaceWorkflow } from '@hyperneo/shared';

// ── helpers ──────────────────────────────────────────────────────────────────

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
    ],
    tags: [],
    startNodeId: 'n1',
    endNodeId: 'n2',
    createdAt: 1000,
    updatedAt: 2000,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

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
    // Sorted alphabetically: Coder->... comes before Reviewer->...
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
    // Verify the "to" array is sorted
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.to).toEqual(['QA', 'Reviewer']);
  });

  it('includes channel gateId and maxCycles in serialization', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: 'Reviewer', gateId: 'gate-1', maxCycles: 3 }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.gateId).toBe('gate-1');
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

  it('uses null for missing channel gateId, maxCycles, and label', () => {
    const wf = makeWorkflow({
      channels: [{ id: 'ch1', from: 'Coder', to: 'Reviewer' }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.channels[0]);
    expect(parsed.gateId).toBeNull();
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
    // Verify the normalized form is a string, not an array
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
    expect(parsed.to).toEqual(['QA', 'Reviewer']); // sorted
  });

  it('returns sorted gate JSON serializations', () => {
    const wf = makeWorkflow({
      gates: [
        { id: 'gate-z', resetOnCycle: false },
        { id: 'gate-a', resetOnCycle: false },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.gates).toHaveLength(2);
    const parsed0 = JSON.parse(fp.gates[0]);
    const parsed1 = JSON.parse(fp.gates[1]);
    expect(parsed0.id).toBe('gate-a');
    expect(parsed1.id).toBe('gate-z');
  });

  it('uses empty string for missing description/instructions', () => {
    const wf = makeWorkflow({ description: undefined, instructions: undefined });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.description).toBe('');
    expect(fp.instructions).toBe('');
  });

  it('treats empty channels, gates, and hooks as empty arrays', () => {
    const wf = makeWorkflow({ channels: undefined, gates: undefined, hooks: undefined });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.channels).toEqual([]);
    expect(fp.gates).toEqual([]);
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
    expect(fp.nodePrompts[0]).toBe('Coder|coder|Write clean code');
    expect(fp.nodePrompts[1]).toBe('Reviewer|reviewer|');
  });

  it('uses empty string for missing customPrompt in nodePrompts', () => {
    const wf = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Coder', agents: [{ agentId: 'a1', name: 'coder' }] }],
    });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.nodePrompts[0]).toBe('Coder|coder|');
  });

  it('includes completionAutonomyLevel in fingerprint', () => {
    const wf = makeWorkflow({ completionAutonomyLevel: 5 });
    const fp = buildWorkflowFingerprint(wf);
    expect(fp.completionAutonomyLevel).toBe(5);
  });

  it('serializes gate fields with name, type, and full check object', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.fields[0].name).toBe('approved');
    expect(parsed.fields[0].type).toBe('boolean');
    expect(parsed.fields[0].check).toEqual({ op: 'exists' });
  });

  it('includes requiredLevel in gate serialization', () => {
    const wf = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false, requiredLevel: 3 }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.id).toBe('gate-1');
    expect(parsed.requiredLevel).toBe(3);
  });

  it('defaults requiredLevel to 0 when absent', () => {
    const wf = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.requiredLevel).toBe(0);
  });

  it('includes resetOnCycle in gate serialization', () => {
    const wfFalse = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const wfTrue = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: true }],
    });
    const parsedFalse = JSON.parse(buildWorkflowFingerprint(wfFalse).gates[0]);
    const parsedTrue = JSON.parse(buildWorkflowFingerprint(wfTrue).gates[0]);
    expect(parsedFalse.resetOnCycle).toBe(false);
    expect(parsedTrue.resetOnCycle).toBe(true);
  });

  it('includes gate script source in serialization', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          script: { interpreter: 'bash', source: 'echo "hello world"' },
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.script).toBe('echo "hello world"');
  });

  it('uses null for gate script when absent', () => {
    const wf = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.script).toBeNull();
  });

  it('includes full gate script source (no truncation)', () => {
    const longScript = 'a'.repeat(100);
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          script: { interpreter: 'bash', source: longScript },
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.script).toBe(longScript);
    expect(parsed.script).toHaveLength(100);
  });

  it('includes gate poll in serialization when present', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: {
            intervalMs: 30_000,
            target: 'to' as const,
            script: 'gh pr view --json mergeable',
            messageTemplate: 'PR update: {{output}}',
          },
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.poll).toEqual({
      intervalMs: 30_000,
      target: 'to',
      messageTemplate: 'PR update: {{output}}',
      script: 'gh pr view --json mergeable',
    });
  });

  it('uses null for gate poll when absent', () => {
    const wf = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.poll).toBeNull();
  });

  it('uses empty string for missing poll messageTemplate', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: {
            intervalMs: 10_000,
            target: 'from' as const,
            script: 'echo test',
          },
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.poll.messageTemplate).toBe('');
  });

  it('includes full poll script (no truncation)', () => {
    const longScript = 'x'.repeat(100);
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: {
            intervalMs: 10_000,
            target: 'to' as const,
            script: longScript,
          },
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.poll.script).toBe(longScript);
    expect(parsed.poll.script).toHaveLength(100);
  });

  it('includes sorted writers in gate field serialization', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['Reviewer', 'Coder'],
              check: { op: 'exists' },
            },
          ],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.fields[0].writers).toEqual(['Coder', 'Reviewer']);
    expect(parsed.fields[0].name).toBe('approved');
  });

  it('sorts gate fields by name for canonical ordering', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            { name: 'zebra', type: 'boolean', writers: [], check: { op: 'exists' } },
            { name: 'alpha', type: 'boolean', writers: [], check: { op: 'exists' } },
            { name: 'middle', type: 'boolean', writers: [], check: { op: 'exists' } },
          ],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    expect(parsed.fields.map((f: { name: string }) => f.name)).toEqual([
      'alpha',
      'middle',
      'zebra',
    ]);
  });

  it('serializes check objects with deterministic key ordering', () => {
    const wf = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            {
              name: 'votes',
              type: 'map',
              writers: [],
              check: { op: 'count', match: 'approved', min: 3 },
            },
          ],
        },
      ],
    });
    const fp = buildWorkflowFingerprint(wf);
    const parsed = JSON.parse(fp.gates[0]);
    // Keys should be in fixed order: op, match, min
    expect(Object.keys(parsed.fields[0].check)).toEqual(['op', 'match', 'min']);
    expect(parsed.fields[0].check).toEqual({ op: 'count', match: 'approved', min: 3 });
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

  it('is stable regardless of gate field insertion order', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            { name: 'b_field', type: 'boolean', writers: [], check: { op: 'exists' } },
            { name: 'a_field', type: 'boolean', writers: [], check: { op: 'exists' } },
          ],
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            { name: 'a_field', type: 'boolean', writers: [], check: { op: 'exists' } },
            { name: 'b_field', type: 'boolean', writers: [], check: { op: 'exists' } },
          ],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });

  it('sorts duplicate-name gate fields by type then check for total ordering', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            { name: 'dup', type: 'boolean', writers: [], check: { op: 'exists' } },
            { name: 'dup', type: 'map', writers: [], check: { op: 'count', match: 'yes', min: 1 } },
            { name: 'dup', type: 'boolean', writers: [], check: { op: '==', value: true } },
          ],
        },
      ],
    });
    // Same fields in different insertion order
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            { name: 'dup', type: 'map', writers: [], check: { op: 'count', match: 'yes', min: 1 } },
            { name: 'dup', type: 'boolean', writers: [], check: { op: '==', value: true } },
            { name: 'dup', type: 'boolean', writers: [], check: { op: 'exists' } },
          ],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).toBe(computeWorkflowHash(wf2));
  });

  it('is stable for scalar checks regardless of key insertion order', () => {
    // Simulate a check object parsed from JSON with different key ordering
    const checkObj = JSON.parse('{"value":true,"op":"=="}') as { op: string; value: unknown };
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: [],
              check: { op: '==', value: true },
            },
          ],
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: [],
              check: checkObj as any,
            },
          ],
        },
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

  it('DOES change when channel gateId changes', () => {
    const wf1 = makeWorkflow({
      channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer' }],
    });
    const wf2 = makeWorkflow({
      channels: [{ id: 'c1', from: 'Coder', to: 'Reviewer', gateId: 'gate-1' }],
    });
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

  it('DOES change when a gate field is added', () => {
    const wf1 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false, fields: [] }],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate field writers change', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            { name: 'approved', type: 'boolean', writers: ['reviewer'], check: { op: 'exists' } },
          ],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when a gate field check op changes', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: [],
              check: { op: '==', value: true },
            },
          ],
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate requiredLevel changes', () => {
    const wf1 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false, requiredLevel: 3 }],
    });
    const wf2 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false, requiredLevel: 4 }],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate resetOnCycle changes', () => {
    const wf1 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const wf2 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: true }],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate script changes', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          script: { interpreter: 'bash', source: 'echo "check A"' },
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          script: { interpreter: 'bash', source: 'echo "check B"' },
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate script is added', () => {
    const wf1 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          script: { interpreter: 'bash', source: 'gh pr view --json mergeable' },
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate poll is added', () => {
    const wf1 = makeWorkflow({
      gates: [{ id: 'gate-1', resetOnCycle: false }],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: {
            intervalMs: 30_000,
            target: 'to',
            script: 'gh pr checks',
          },
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate poll intervalMs changes', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: { intervalMs: 10_000, target: 'to', script: 'echo 1' },
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: { intervalMs: 30_000, target: 'to', script: 'echo 1' },
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate poll target changes', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: { intervalMs: 10_000, target: 'from', script: 'echo 1' },
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: { intervalMs: 10_000, target: 'to', script: 'echo 1' },
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate poll script changes', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: { intervalMs: 10_000, target: 'to', script: 'echo old' },
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: { intervalMs: 10_000, target: 'to', script: 'echo new' },
        },
      ],
    });
    expect(computeWorkflowHash(wf1)).not.toBe(computeWorkflowHash(wf2));
  });

  it('DOES change when gate poll messageTemplate changes', () => {
    const wf1 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: {
            intervalMs: 10_000,
            target: 'to',
            script: 'echo 1',
            messageTemplate: 'Old: {{output}}',
          },
        },
      ],
    });
    const wf2 = makeWorkflow({
      gates: [
        {
          id: 'gate-1',
          resetOnCycle: false,
          poll: {
            intervalMs: 10_000,
            target: 'to',
            script: 'echo 1',
            messageTemplate: 'New: {{output}}',
          },
        },
      ],
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
});
