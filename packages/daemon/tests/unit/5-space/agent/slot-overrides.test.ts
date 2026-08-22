import { describe, expect, it } from 'bun:test';
import type { WorkflowNodeAgent } from '@hyperneo/shared';
import { buildSlotOverrides } from '../../../../src/lib/space/runtime/spawn-slot-resolution';
import { resolveCustomAgentPrompt } from '../../../../src/lib/space/agents/custom-agent';
import type { SpaceWorkerAgent } from '@hyperneo/shared';

function makeSlot(overrides?: Partial<WorkflowNodeAgent>): WorkflowNodeAgent {
  return {
    agentId: 'agent-1',
    name: 'Coder',
    ...overrides,
  };
}

describe('buildSlotOverrides', () => {
  it('threads replaceAgentPrompt from the workflow slot into SlotOverrides', () => {
    const overrides = buildSlotOverrides(
      makeSlot({ customPrompt: { value: 'Slot prompt' }, replaceAgentPrompt: true })
    );

    expect(overrides.replaceAgentPrompt).toBe(true);
    expect(overrides.customPrompt).toBe('Slot prompt');
  });

  it('leaves replaceAgentPrompt undefined when the slot does not set it', () => {
    const overrides = buildSlotOverrides(makeSlot({ customPrompt: { value: 'Slot prompt' } }));

    expect(overrides.replaceAgentPrompt).toBeUndefined();
  });

  it('passes replaceAgentPrompt:false through unchanged', () => {
    const overrides = buildSlotOverrides(
      makeSlot({ customPrompt: { value: 'Slot prompt' }, replaceAgentPrompt: false })
    );

    expect(overrides.replaceAgentPrompt).toBe(false);
  });

  it('produces a SlotOverrides that resolveCustomAgentPrompt honors as a replace', () => {
    const agent: SpaceWorkerAgent = {
      id: 'agent-1',
      spaceId: 'space-1',
      name: 'Reviewer',
      customPrompt: 'Agent base contract',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const overrides = buildSlotOverrides(
      makeSlot({ customPrompt: { value: 'Slot replaces base' }, replaceAgentPrompt: true })
    );

    const resolved = resolveCustomAgentPrompt(agent, overrides);
    expect(resolved.value).toBe('Slot replaces base');
    expect(resolved.value).not.toContain('Agent base contract');
    expect(resolved.source).toBe('workflow_node_replaced_prompt');
  });

  it('still resolves legacy systemPrompt/instructions into customPrompt (migration 79 compat)', () => {
    const legacySlot = makeSlot({
      customPrompt: undefined,
    }) as WorkflowNodeAgent & {
      systemPrompt?: { value: string };
      instructions?: { value: string };
    };
    legacySlot.systemPrompt = { value: 'Legacy system prompt' };
    legacySlot.instructions = { value: 'Legacy instructions' };

    const overrides = buildSlotOverrides(legacySlot);
    expect(overrides.customPrompt).toBe('Legacy system prompt\n\nLegacy instructions');
  });

  it('ignores legacy systemPrompt/instructions in replace mode (empty replace = bare contract)', () => {
    const legacySlot = makeSlot({
      customPrompt: undefined,
      replaceAgentPrompt: true,
    }) as WorkflowNodeAgent & {
      systemPrompt?: { value: string };
      instructions?: { value: string };
    };
    legacySlot.systemPrompt = { value: 'Legacy hidden prompt' };
    legacySlot.instructions = { value: 'Legacy instructions' };

    const overrides = buildSlotOverrides(legacySlot);
    expect(overrides.replaceAgentPrompt).toBe(true);
    expect(overrides.customPrompt).toBeUndefined();

    const resolved = resolveCustomAgentPrompt(
      {
        id: 'agent-1',
        spaceId: 'space-1',
        name: 'Reviewer',
        customPrompt: 'Agent base contract',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      overrides
    );
    expect(resolved.value).toBe('');
    expect(resolved.source).toBe('empty');
    expect(resolved.value).not.toContain('Legacy hidden prompt');
  });

  it('uses the explicit customPrompt (not legacy fields) when replacing', () => {
    const legacySlot = makeSlot({
      customPrompt: { value: 'Explicit replacement' },
      replaceAgentPrompt: true,
    }) as WorkflowNodeAgent & {
      systemPrompt?: { value: string };
      instructions?: { value: string };
    };
    legacySlot.systemPrompt = { value: 'Legacy hidden prompt' };

    const overrides = buildSlotOverrides(legacySlot);
    expect(overrides.customPrompt).toBe('Explicit replacement');
  });
});
