import { describe, expect, test } from 'bun:test';
import {
  collectTemplateOwnershipEvidence,
  migratedAgentIdCandidates,
  type TemplateOwnershipInputs,
} from '../../../../src/lib/space/agents/template-ownership-evidence.ts';

function inputs(overrides: Partial<TemplateOwnershipInputs> = {}): TemplateOwnershipInputs {
  return {
    templates: [],
    agents: [],
    workflowSlots: [],
    ...overrides,
  };
}

describe('migratedAgentIdCandidates', () => {
  test('ignores keys outside the migrated namespace', () => {
    expect(migratedAgentIdCandidates('worker.swe')).toEqual([]);
    expect(migratedAgentIdCandidates('migrated.agent.')).toEqual([]);
  });

  test('offers the raw remainder first so agent ids containing dots still match', () => {
    expect(migratedAgentIdCandidates('migrated.agent.space-lh-agent:coordinator:sp.1')).toEqual([
      'space-lh-agent:coordinator:sp.1',
    ]);
  });

  test('offers a probe-stripped candidate for m228 collision keys', () => {
    expect(migratedAgentIdCandidates('migrated.agent.a1.m228')).toEqual(['a1.m228', 'a1']);
    expect(migratedAgentIdCandidates('migrated.agent.a1.m228-3')).toEqual(['a1.m228-3', 'a1']);
  });

  test('does not strip a suffix that only looks like a probe', () => {
    expect(migratedAgentIdCandidates('migrated.agent.a1.m228-x')).toEqual(['a1.m228-x']);
  });
});

describe('collectTemplateOwnershipEvidence', () => {
  test('returns an entry for every known key and nothing for unknown keys', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [
          { key: 'custom.one', createdAt: 0 },
          { key: '  ', createdAt: 0 },
          { key: 'custom.two', createdAt: 0 },
        ],
        workflowSlots: [{ spaceId: 'sp1', templateKey: 'not.a.known.key' }],
      })
    );
    expect([...evidence.keys()].sort()).toEqual(['custom.one', 'custom.two']);
    expect(evidence.get('custom.one')).toEqual({
      migratedAgentSpaces: [],
      agentReferenceSpaces: [],
      workflowSlotSpaces: [],
    });
  });

  test('attributes a migrated key to the Space of the agent it was synthesized from', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [
          { key: 'migrated.agent.a1', createdAt: 0 },
          { key: 'migrated.agent.a2.m228-2', createdAt: 0 },
        ],
        agents: [
          { id: 'a1', spaceId: 'sp1', templateKey: null, createdAt: 0 },
          { id: 'a2', spaceId: 'sp2', templateKey: null, createdAt: 0 },
        ],
      })
    );
    expect(evidence.get('migrated.agent.a1')?.migratedAgentSpaces).toEqual(['sp1']);
    expect(evidence.get('migrated.agent.a2.m228-2')?.migratedAgentSpaces).toEqual(['sp2']);
  });

  test('keeps both Spaces when a collision key is ambiguous between two agents', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'migrated.agent.a1.m228', createdAt: 0 }],
        agents: [
          { id: 'a1.m228', spaceId: 'exact', templateKey: null, createdAt: 0 },
          { id: 'a1', spaceId: 'stripped', templateKey: null, createdAt: 0 },
        ],
      })
    );
    expect(evidence.get('migrated.agent.a1.m228')?.migratedAgentSpaces).toEqual([
      'exact',
      'stripped',
    ]);
  });

  test('collects agent, workflow slot and audit references across Spaces', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'shared.one', createdAt: 0 }],
        agents: [
          { id: 'a1', spaceId: 'sp1', templateKey: 'shared.one', createdAt: 0 },
          { id: 'a2', spaceId: 'sp2', templateKey: 'shared.one', createdAt: 0 },
          { id: 'a3', spaceId: 'sp1', templateKey: 'shared.one', createdAt: 0 },
        ],
        workflowSlots: [
          { spaceId: 'sp3', templateKey: 'shared.one' },
          { spaceId: 'sp3', templateKey: 'shared.one' },
        ],
      })
    );
    const entry = evidence.get('shared.one');
    expect(entry?.agentReferenceSpaces).toEqual(['sp1', 'sp2']);
    expect(entry?.workflowSlotSpaces).toEqual(['sp3']);
  });

  test('ignores blank Space ids and blank template references', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'custom.one', createdAt: 0 }],
        agents: [{ id: 'a1', spaceId: '   ', templateKey: 'custom.one', createdAt: 0 }],
        workflowSlots: [{ spaceId: 'sp1', templateKey: '   ' }],
      })
    );
    const entry = evidence.get('custom.one');
    expect(entry?.agentReferenceSpaces).toEqual([]);
    expect(entry?.workflowSlotSpaces).toEqual([]);
  });

  test('trims keys and Space ids before matching', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: '  custom.one  ', createdAt: 0 }],
        workflowSlots: [{ spaceId: ' sp1 ', templateKey: ' custom.one ' }],
      })
    );
    expect(evidence.get('custom.one')?.workflowSlotSpaces).toEqual(['sp1']);
  });
  test('rejects a replacement agent created after the template it would claim', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'migrated.agent.reused', createdAt: 1_000 }],
        agents: [{ id: 'reused', spaceId: 'replacement', templateKey: null, createdAt: 5_000 }],
      })
    );
    expect(evidence.get('migrated.agent.reused')?.migratedAgentSpaces).toEqual([]);
  });

  test('rejects an agent reference that predates the current template row', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'shared.one', createdAt: 5_000 }],
        agents: [
          { id: 'stale', spaceId: 'former', templateKey: 'shared.one', createdAt: 1_000 },
          { id: 'fresh', spaceId: 'current', templateKey: 'shared.one', createdAt: 9_000 },
        ],
      })
    );
    expect(evidence.get('shared.one')?.agentReferenceSpaces).toEqual(['current']);
  });
});
