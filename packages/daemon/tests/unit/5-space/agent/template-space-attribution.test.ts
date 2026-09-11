import { describe, expect, test } from 'bun:test';
import {
  planTemplateSpaceAssignments,
  type TemplateAttributionInputs,
} from '../../../../src/lib/space/agents/template-space-attribution.ts';

function inputs(overrides: Partial<TemplateAttributionInputs> = {}): TemplateAttributionInputs {
  return { templates: [], agents: [], workflowSlots: [], spaceIds: [], ...overrides };
}

describe('planTemplateSpaceAssignments', () => {
  test('assigns a synthesized template to the Space of its source agent', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'migrated.agent.a1', createdAt: 5_000 }],
        agents: [{ id: 'a1', spaceId: 'sp1', createdAt: 1_000 }],
        spaceIds: ['sp1', 'sp2'],
      })
    );
    expect(plan.assignments).toEqual([
      { key: 'migrated.agent.a1', spaceIds: ['sp1'], rung: 'synthesized-from-agent' },
    ]);
    expect(plan.deletions).toEqual([]);
  });

  test('synthesis provenance outranks a workflow slot in another Space', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'migrated.agent.a1', createdAt: 5_000 }],
        agents: [{ id: 'a1', spaceId: 'origin', createdAt: 1_000 }],
        workflowSlots: [{ spaceId: 'borrower', templateKey: 'migrated.agent.a1' }],
        spaceIds: ['origin', 'borrower'],
      })
    );
    expect(plan.assignments[0].rung).toBe('synthesized-from-agent');
    expect(plan.assignments[0].spaceIds).toEqual(['origin']);
  });

  test('copies into every Space whose workflow slots name the key', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'shared.one', createdAt: 0 }],
        workflowSlots: [
          { spaceId: 'sp1', templateKey: 'shared.one' },
          { spaceId: 'sp2', templateKey: 'shared.one' },
        ],
        spaceIds: ['sp1', 'sp2', 'sp3'],
      })
    );
    expect(plan.assignments).toEqual([
      { key: 'shared.one', spaceIds: ['sp1', 'sp2'], rung: 'workflow-slot-reference' },
    ]);
  });

  test('copies into both Spaces when synthesis provenance is ambiguous', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'migrated.agent.a1.m228', createdAt: 5_000 }],
        agents: [
          { id: 'a1.m228', spaceId: 'exact', createdAt: 1_000 },
          { id: 'a1', spaceId: 'stripped', createdAt: 1_000 },
        ],
        spaceIds: ['exact', 'stripped'],
      })
    );
    expect(plan.assignments[0].spaceIds).toEqual(['exact', 'stripped']);
  });

  test('assigns an unreferenced template to the only Space on the install', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'orphan.one', createdAt: 0 }],
        spaceIds: ['only'],
      })
    );
    expect(plan.assignments).toEqual([
      { key: 'orphan.one', spaceIds: ['only'], rung: 'sole-space' },
    ]);
    expect(plan.deletions).toEqual([]);
  });

  test('deletes an unreferenced template when several Spaces exist', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'orphan.one', createdAt: 0 }],
        spaceIds: ['sp1', 'sp2'],
      })
    );
    expect(plan.assignments).toEqual([]);
    expect(plan.deletions).toEqual(['orphan.one']);
  });

  test('deletes rather than assigning to a Space that no longer exists', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'migrated.agent.a1', createdAt: 5_000 }],
        agents: [{ id: 'a1', spaceId: 'deleted-space', createdAt: 1_000 }],
        spaceIds: ['sp1', 'sp2'],
      })
    );
    expect(plan.assignments).toEqual([]);
    expect(plan.deletions).toEqual(['migrated.agent.a1']);
  });

  test('keeps the surviving Space when provenance names one live and one dead Space', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'migrated.agent.a1.m228', createdAt: 5_000 }],
        agents: [
          { id: 'a1.m228', spaceId: 'gone', createdAt: 1_000 },
          { id: 'a1', spaceId: 'alive', createdAt: 1_000 },
        ],
        spaceIds: ['alive'],
      })
    );
    expect(plan.assignments[0].spaceIds).toEqual(['alive']);
    expect(plan.deletions).toEqual([]);
  });

  test('deletes every unattributed row on an install with no Spaces at all', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [
          { key: 'a', createdAt: 0 },
          { key: 'b', createdAt: 0 },
        ],
        spaceIds: [],
      })
    );
    expect(plan.assignments).toEqual([]);
    expect(plan.deletions).toEqual(['a', 'b']);
  });

  test('trims and deduplicates the Space list before deciding sole-space', () => {
    const plan = planTemplateSpaceAssignments(
      inputs({
        templates: [{ key: 'orphan.one', createdAt: 0 }],
        spaceIds: [' only ', 'only', '   '],
      })
    );
    expect(plan.assignments).toEqual([
      { key: 'orphan.one', spaceIds: ['only'], rung: 'sole-space' },
    ]);
  });
});
