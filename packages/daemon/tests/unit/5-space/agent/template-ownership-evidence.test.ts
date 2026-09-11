import { describe, expect, test } from 'bun:test';
import {
  collectTemplateOwnershipEvidence,
  migratedAgentIdCandidates,
  type TemplateOwnershipInputs,
} from '../../../../src/lib/space/agents/template-ownership-evidence.ts';

function inputs(overrides: Partial<TemplateOwnershipInputs> = {}): TemplateOwnershipInputs {
  return { templates: [], agents: [], workflowSlots: [], ...overrides };
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

  test('strips only the ordinals the m228 probe loop can emit', () => {
    expect(migratedAgentIdCandidates('migrated.agent.a.m228-2')).toEqual(['a.m228-2', 'a']);
    expect(migratedAgentIdCandidates('migrated.agent.a.m228-100')).toEqual(['a.m228-100', 'a']);
    expect(migratedAgentIdCandidates('migrated.agent.a.m228-1')).toEqual(['a.m228-1']);
    expect(migratedAgentIdCandidates('migrated.agent.a.m228-0')).toEqual(['a.m228-0']);
    expect(migratedAgentIdCandidates('migrated.agent.a.m228-101')).toEqual(['a.m228-101']);
    expect(migratedAgentIdCandidates('migrated.agent.a.m228-02')).toEqual(['a.m228-02']);
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
      synthesizedFromSpaces: [],
      workflowSlotSpaces: [],
    });
  });

  test('attributes a migrated key to the Space of the agent it was synthesized from', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [
          { key: 'migrated.agent.a1', createdAt: 5_000 },
          { key: 'migrated.agent.a2.m228-2', createdAt: 5_000 },
        ],
        agents: [
          { id: 'a1', spaceId: 'sp1', createdAt: 1_000 },
          { id: 'a2', spaceId: 'sp2', createdAt: 1_000 },
        ],
      })
    );
    expect(evidence.get('migrated.agent.a1')?.synthesizedFromSpaces).toEqual(['sp1']);
    expect(evidence.get('migrated.agent.a2.m228-2')?.synthesizedFromSpaces).toEqual(['sp2']);
  });

  test('keeps both Spaces when a collision key is ambiguous between two agents', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'migrated.agent.a1.m228', createdAt: 5_000 }],
        agents: [
          { id: 'a1.m228', spaceId: 'exact', createdAt: 1_000 },
          { id: 'a1', spaceId: 'stripped', createdAt: 1_000 },
        ],
      })
    );
    expect(evidence.get('migrated.agent.a1.m228')?.synthesizedFromSpaces).toEqual([
      'exact',
      'stripped',
    ]);
  });

  test('rejects a replacement agent created after the template it would claim', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'migrated.agent.reused', createdAt: 1_000 }],
        agents: [{ id: 'reused', spaceId: 'replacement', createdAt: 5_000 }],
      })
    );
    expect(evidence.get('migrated.agent.reused')?.synthesizedFromSpaces).toEqual([]);
  });

  test('collects every Space whose workflow slots name the key', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'shared.one', createdAt: 0 }],
        workflowSlots: [
          { spaceId: 'sp3', templateKey: 'shared.one' },
          { spaceId: 'sp3', templateKey: 'shared.one' },
          { spaceId: 'sp4', templateKey: 'shared.one' },
        ],
      })
    );
    expect(evidence.get('shared.one')?.workflowSlotSpaces).toEqual(['sp3', 'sp4']);
  });

  test('counts a slot reference regardless of which template generation it was written against', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'shared.one', createdAt: 9_000 }],
        workflowSlots: [{ spaceId: 'older-workflow', templateKey: 'shared.one' }],
      })
    );
    expect(evidence.get('shared.one')?.workflowSlotSpaces).toEqual(['older-workflow']);
  });

  test('ignores blank Space ids and blank template references', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'custom.one', createdAt: 0 }],
        workflowSlots: [{ spaceId: 'sp1', templateKey: '   ' }],
      })
    );
    expect(evidence.get('custom.one')?.workflowSlotSpaces).toEqual([]);
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
  test('does not let a whitespace-bearing agent id stand in for the exact one', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'migrated.agent.a1', createdAt: 5_000 }],
        agents: [{ id: ' a1 ', spaceId: 'other-space', createdAt: 1_000 }],
      })
    );
    expect(evidence.get('migrated.agent.a1')?.synthesizedFromSpaces).toEqual([]);
  });

  test('keeps the exact agent id when a whitespace variant also exists', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'migrated.agent.a1', createdAt: 5_000 }],
        agents: [
          { id: ' a1 ', spaceId: 'whitespace-space', createdAt: 1_000 },
          { id: 'a1', spaceId: 'exact-space', createdAt: 1_000 },
        ],
      })
    );
    expect(evidence.get('migrated.agent.a1')?.synthesizedFromSpaces).toEqual(['exact-space']);
  });
});
