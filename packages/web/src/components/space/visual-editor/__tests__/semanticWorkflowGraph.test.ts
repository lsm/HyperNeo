import type { Gate, WorkflowChannel } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { buildSemanticWorkflowEdges } from '../semanticWorkflowGraph';
import type { VisualNode } from '../serialization';

const NODES: VisualNode[] = [
  {
    step: {
      localId: 'plan',
      name: 'Planning',
      agentId: 'planner-id',
    },
    position: { x: 50, y: 170 },
  },
  {
    step: {
      localId: 'review',
      name: 'Code Review',
      agentId: '',

      agents: [
        { agentId: 'reviewer-1-id', name: 'Reviewer 1' },
        { agentId: 'reviewer-2-id', name: 'Reviewer 2' },
        { agentId: 'reviewer-3-id', name: 'Reviewer 3' },
      ],
    },
    position: { x: 50, y: 320 },
  },
  {
    step: {
      localId: 'qa',
      name: 'QA',
      agentId: 'qa-id',
    },
    position: { x: 50, y: 470 },
  },
];

/** Helper: create a Gate with only fields (approved → human gate). */
function humanGate(id: string, overrides?: Partial<Gate>): Gate {
  return {
    id,
    resetOnCycle: false,
    fields: [
      {
        name: 'approved',
        type: 'boolean',
        writers: [],
        check: { op: '==', value: true },
      },
    ],
    ...overrides,
  };
}

/** Helper: create a check gate with no label/color/script. */
function checkGate(id: string, overrides?: Partial<Gate>): Gate {
  return {
    id,
    resetOnCycle: false,
    ...overrides,
  };
}

describe('buildSemanticWorkflowEdges', () => {
  it('preserves a node-level channel between a single-agent node and a multi-agent node', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review' }];

    expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
      {
        id: 'plan:review',
        fromStepId: 'plan',
        toStepId: 'review',
        direction: 'one-way',
        channelCount: 1,
        hasGate: false,
        hasCyclic: false,
        gateType: undefined,
        gateLabel: undefined,
        gateColor: undefined,
        hasScript: undefined,
        channelIndexes: [0],
      },
    ]);
  });

  it('collapses opposite directions into one bidirectional semantic edge', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review' },
      { from: 'Code Review', to: 'Planning' },
    ];

    expect(buildSemanticWorkflowEdges(NODES, channels)).toEqual([
      {
        id: 'plan:review',
        fromStepId: 'plan',
        toStepId: 'review',
        direction: 'bidirectional',
        channelCount: 2,
        hasGate: false,
        hasCyclic: false,
        gateType: undefined,
        gateLabel: undefined,
        gateColor: undefined,
        hasScript: undefined,
        reverseGateType: undefined,
        reverseGateLabel: undefined,
        reverseGateColor: undefined,
        reverseHasScript: undefined,
        channelIndexes: [0, 1],
      },
    ]);
  });

  it('ignores unresolved and intra-node channels for the semantic canvas graph', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Unknown', to: 'Planning' },
      { from: 'Reviewer 1', to: 'Reviewer 2' },
      { from: 'Code Review', to: 'QA', gateId: 'g1' },
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('review:qa');
    expect(result[0].fromStepId).toBe('review');
    expect(result[0].toStepId).toBe('qa');
    expect(result[0].direction).toBe('one-way');
    expect(result[0].hasGate).toBe(true);
    // gateType is derived from the gate definition; when gate lookup has no data,
    // resolveSemanticGateType falls back to 'check'.
    expect(result[0].gateType).toBeTruthy();
  });

  it('tracks per-direction gate types for bidirectional edges', () => {
    // Two one-way channels going opposite directions, each with a gate.
    // plan→review (lowId→highId) has a gate; review→plan (highId→lowId) also has a gate.
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review', gateId: 'gate-fwd' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [humanGate('gate-fwd'), humanGate('gate-rev')];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('bidirectional');
    expect(result[0].hasGate).toBe(true);
    // Forward gate (plan→review = lowId→highId)
    expect(result[0].gateType).toBe('check');
    // Reverse gate (review→plan = highId→lowId)
    expect(result[0].reverseGateType).toBe('check');
  });

  it('does not set reverseGateType when only the forward direction has a gate', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review', gateId: 'gate-fwd' },
      { from: 'Code Review', to: 'Planning' },
    ];
    const gates = [humanGate('gate-fwd')];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].direction).toBe('bidirectional');
    expect(result[0].gateType).toBe('check');
    expect(result[0].reverseGateType).toBeUndefined();
  });

  it('does not set gateType when only the reverse direction has a gate', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [humanGate('gate-rev')];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].direction).toBe('bidirectional');
    expect(result[0].gateType).toBeUndefined();
    expect(result[0].reverseGateType).toBe('check');
  });

  it('a bidirectional underlying channel gates both directions', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-both' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-both' },
    ];
    const gates = [humanGate('gate-both')];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].direction).toBe('bidirectional');
    expect(result[0].gateType).toBe('check');
    expect(result[0].reverseGateType).toBe('check');
  });
});

describe('gate label/color/hasScript propagation', () => {
  it('propagates gate label and color for a one-way edge', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [
      humanGate('g1', {
        label: 'Team Lead',
        color: '#ff5500',
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateType: 'check',
      gateLabel: 'Team Lead',
      gateColor: '#ff5500',
      hasScript: undefined,
    });
  });

  it('propagates hasScript when gate has a script', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [
      checkGate('g1', {
        script: { interpreter: 'bash', source: 'exit 0' },
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateType: 'check',
      hasScript: true,
    });
  });

  it('returns undefined for label/color when gate has neither', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [humanGate('g1')];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].gateLabel).toBeUndefined();
    expect(result[0].gateColor).toBeUndefined();
    expect(result[0].hasScript).toBeUndefined();
  });

  it('returns undefined for label/color/hasScript when gate is missing from lookup', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review', gateId: 'missing-gate' },
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels);
    expect(result[0].gateType).toBe('check');
    expect(result[0].gateLabel).toBeUndefined();
    expect(result[0].gateColor).toBeUndefined();
    expect(result[0].hasScript).toBeUndefined();
  });

  it('returns undefined for label/color/hasScript when channel has no gateId', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review' }];

    const result = buildSemanticWorkflowEdges(NODES, channels);
    expect(result[0].gateType).toBeUndefined();
    expect(result[0].gateLabel).toBeUndefined();
    expect(result[0].gateColor).toBeUndefined();
    expect(result[0].hasScript).toBeUndefined();
  });

  it('propagates label/color/hasScript for bidirectional edges per direction', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review', gateId: 'gate-fwd' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [
      humanGate('gate-fwd', {
        label: 'Forward',
        color: '#00ff00',
        script: { interpreter: 'bash', source: 'echo ok' },
      }),
      humanGate('gate-rev', {
        label: 'Reverse',
        color: '#ff0000',
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      gateType: 'check',
      gateLabel: 'Forward',
      gateColor: '#00ff00',
      hasScript: true,
      reverseGateType: 'check',
      reverseGateLabel: 'Reverse',
      reverseGateColor: '#ff0000',
      reverseHasScript: undefined,
    });
  });

  it('propagates label/color/hasScript for a bidirectional underlying channel to both directions', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-both' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-both' },
    ];
    const gates = [
      humanGate('gate-both', {
        label: 'Both Ways',
        color: '#123456',
        script: { interpreter: 'python3', source: 'print("ok")' },
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateType: 'check',
      gateLabel: 'Both Ways',
      gateColor: '#123456',
      hasScript: true,
      reverseGateType: 'check',
      reverseGateLabel: 'Both Ways',
      reverseGateColor: '#123456',
      reverseHasScript: true,
    });
  });

  it('tracks label/color/hasScript only for forward direction when only forward has a gate', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review', gateId: 'gate-fwd' },
      { from: 'Code Review', to: 'Planning' },
    ];
    const gates = [
      checkGate('gate-fwd', {
        label: 'Fwd Only',
        color: '#abcdef',
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateType: 'check',
      gateLabel: 'Fwd Only',
      gateColor: '#abcdef',
      reverseGateType: undefined,
      reverseGateLabel: undefined,
      reverseGateColor: undefined,
      reverseHasScript: undefined,
    });
  });

  it('tracks label/color/hasScript only for reverse direction when only reverse has a gate', () => {
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Code Review' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [
      checkGate('gate-rev', {
        label: 'Rev Only',
        color: '#fedcba',
        script: { interpreter: 'bash', source: 'true' },
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateType: undefined,
      gateLabel: undefined,
      gateColor: undefined,
      hasScript: undefined,
      reverseGateType: 'check',
      reverseGateLabel: 'Rev Only',
      reverseGateColor: '#fedcba',
      reverseHasScript: true,
    });
  });

  it('propagates label/color/hasScript for a one-way highToLow edge', () => {
    // review→plan direction (highId→lowId) for a one-way edge
    const channels: WorkflowChannel[] = [
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [
      checkGate('gate-rev', {
        label: 'HighToLow',
        color: '#aabbcc',
        script: { interpreter: 'node', source: 'process.exit(0)' },
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      fromStepId: 'review',
      toStepId: 'plan',
      gateType: 'check',
      gateLabel: 'HighToLow',
      gateColor: '#aabbcc',
      hasScript: true,
    });
  });

  it('gates with label but no color propagate label and undefined color', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [
      humanGate('g1', {
        label: 'Label Only',
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateLabel: 'Label Only',
      gateColor: undefined,
    });
  });

  it('gates with color but no label propagate color and undefined label', () => {
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [
      humanGate('g1', {
        color: '#998877',
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateLabel: undefined,
      gateColor: '#998877',
    });
  });

  it('uses first gate label/color when multiple gates exist on the same direction', () => {
    // Two channels from Planning→Review (different agents), each with a gate.
    // Implementation uses ??= (nullish coalesce assignment) so first non-undefined wins.
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-a' },
      { from: 'Planning', to: 'Reviewer 2', gateId: 'gate-b' },
    ];
    const gates = [
      humanGate('gate-a', { label: 'First', color: '#aa0000' }),
      humanGate('gate-b', { label: 'Second', color: '#00bb00' }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channelCount: 2,
      // First gate's label/color wins (??= skips when non-undefined)
      gateLabel: 'First',
      gateColor: '#aa0000',
    });
  });

  it('second gate label wins when first gate has no label (??= undefined propagation)', () => {
    // ??= only skips assignment when the current value is non-nullish.
    // If the first gate has label: undefined, the second gate's label propagates.
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-a' },
      { from: 'Planning', to: 'Reviewer 2', gateId: 'gate-b' },
    ];
    const gates = [
      humanGate('gate-a'), // no label
      humanGate('gate-b', { label: 'Second', color: '#00bb00' }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].gateLabel).toBe('Second');
    expect(result[0].gateColor).toBe('#00bb00');
  });

  it('sets hasScript to true when any gate on the same direction has a script', () => {
    // Two channels same direction: first gate has no script, second gate has script.
    // Implementation uses `if (gateInfo.hasScript)` which is true if ANY gate has a script.
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-1' },
      { from: 'Planning', to: 'Reviewer 2', gateId: 'gate-2' },
    ];
    const gates = [
      humanGate('gate-1'),
      humanGate('gate-2', { script: { interpreter: 'bash', source: 'exit 0' } }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].hasScript).toBe(true);
  });

  it('gate with both fields and script propagates both gateType and hasScript', () => {
    // A human gate (with approved field) that also has a script.
    // Should produce gateType='check' AND hasScript=true.
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [
      humanGate('g1', {
        label: 'Hybrid Gate',
        color: '#112233',
        script: { interpreter: 'python3', source: 'exit(0)' },
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      gateType: 'check',
      gateLabel: 'Hybrid Gate',
      gateColor: '#112233',
      hasScript: true,
    });
  });

  it('first gate label/color wins on bidirectional edge with multiple gates per direction', () => {
    // Multiple channels in each direction of a bidirectional edge.
    // Forward: two gates (gate-fwd-1 with label/color, gate-fwd-2 with different label/color)
    // Reverse: one gate with its own label/color
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-fwd-1' },
      { from: 'Planning', to: 'Reviewer 2', gateId: 'gate-fwd-2' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [
      humanGate('gate-fwd-1', { label: 'Fwd 1', color: '#111111' }),
      humanGate('gate-fwd-2', { label: 'Fwd 2', color: '#222222' }),
      checkGate('gate-rev', { label: 'Rev', color: '#333333' }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channelCount: 3,
      // Forward: first gate wins for label/color
      gateLabel: 'Fwd 1',
      gateColor: '#111111',
      // Reverse: only one gate
      reverseGateLabel: 'Rev',
      reverseGateColor: '#333333',
    });
  });

  it('hasScript is true on each direction independently when multiple gates have scripts', () => {
    // Forward: two gates, one with script. Reverse: one gate with script.
    // Both directions should have hasScript=true.
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Reviewer 1', gateId: 'gate-fwd-a' },
      { from: 'Planning', to: 'Reviewer 2', gateId: 'gate-fwd-b' },
      { from: 'Code Review', to: 'Planning', gateId: 'gate-rev' },
    ];
    const gates = [
      humanGate('gate-fwd-a'), // no script
      humanGate('gate-fwd-b', { script: { interpreter: 'bash', source: 'exit 0' } }),
      humanGate('gate-rev', { script: { interpreter: 'node', source: 'process.exit(0)' } }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0]).toMatchObject({
      hasScript: true,
      reverseHasScript: true,
    });
  });

  it('gate with script but no fields resolves to check type with hasScript true', () => {
    // Script-only gate (no fields) should still derive gateType='check' from the fallback.
    const channels: WorkflowChannel[] = [{ from: 'Planning', to: 'Code Review', gateId: 'g1' }];
    const gates = [
      checkGate('g1', {
        script: { interpreter: 'node', source: 'console.log("ok")' },
      }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result[0].gateType).toBe('check');
    expect(result[0].gateLabel).toBeUndefined();
    expect(result[0].gateColor).toBeUndefined();
    expect(result[0].hasScript).toBe(true);
  });

  it('different agents from same multi-agent node with gates propagate independently per direction', () => {
    // Reviewer 1→QA with gate A, Reviewer 2→QA with gate B (both same direction: review→qa).
    // Both channels are lowToHigh since review comes before qa in node order.
    const channels: WorkflowChannel[] = [
      { from: 'Reviewer 1', to: 'QA', gateId: 'gate-a' },
      { from: 'Reviewer 2', to: 'QA', gateId: 'gate-b' },
    ];
    const gates = [
      humanGate('gate-a', { label: 'R1 Check', color: '#ff0000' }),
      checkGate('gate-b', { label: 'R2 Check', color: '#0000ff' }),
    ];

    const result = buildSemanticWorkflowEdges(NODES, channels, gates);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fromStepId: 'review',
      toStepId: 'qa',
      channelCount: 2,
      // First gate wins for label/color
      gateLabel: 'R1 Check',
      gateColor: '#ff0000',
    });
  });
});
