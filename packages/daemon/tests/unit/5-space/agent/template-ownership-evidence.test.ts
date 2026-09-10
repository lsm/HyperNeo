import { describe, expect, test } from 'bun:test';
import {
  auditedTemplateKey,
  collectTemplateOwnershipEvidence,
  migratedAgentIdCandidates,
  type TemplateOwnershipInputs,
} from '../../../../src/lib/space/agents/template-ownership-evidence.ts';

function inputs(overrides: Partial<TemplateOwnershipInputs> = {}): TemplateOwnershipInputs {
  return {
    templates: [],
    agents: [],
    workflowSlots: [],
    auditEntries: [],
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

describe('auditedTemplateKey', () => {
  test('reads the key from a create_agent_template entry', () => {
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        timestamp: 0,
        toolName: 'create_agent_template',
        paramsSummary: JSON.stringify({ key: 'custom.one', from_agent_id: 'a1' }),
      })
    ).toBe('custom.one');
  });

  test('ignores other tools, malformed json, and missing keys', () => {
    const base = {
      spaceId: 'sp1',
      paramsSummary: JSON.stringify({ key: 'custom.one' }),
      timestamp: 0,
    };
    expect(auditedTemplateKey({ ...base, toolName: 'delete_agent_template' })).toBeNull();
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        toolName: 'create_agent_template',
        paramsSummary: '{',
        timestamp: 0,
      })
    ).toBeNull();
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        timestamp: 0,
        toolName: 'create_agent_template',
        paramsSummary: JSON.stringify(['custom.one']),
      })
    ).toBeNull();
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        toolName: 'create_agent_template',
        paramsSummary: null,
        timestamp: 0,
      })
    ).toBeNull();
  });

  test('ignores the dispatcher row written before the handler runs', () => {
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        toolName: 'create_agent_template',
        timestamp: 0,
        paramsSummary: JSON.stringify({
          key: 'custom.one',
          handle: 'custom',
          display_name: 'Custom',
        }),
      })
    ).toBeNull();
  });

  test('accepts the handler row with and without from_agent_id', () => {
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        toolName: 'create_agent_template',
        timestamp: 0,
        paramsSummary: JSON.stringify({ key: 'custom.one' }),
      })
    ).toBe('custom.one');
    expect(
      auditedTemplateKey({
        spaceId: 'sp1',
        toolName: 'create_agent_template',
        timestamp: 0,
        paramsSummary: JSON.stringify({ key: 'custom.one', from_agent_id: 'a1' }),
      })
    ).toBe('custom.one');
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
      auditedSpaces: [],
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
          { id: 'a1', spaceId: 'sp1', templateKey: null },
          { id: 'a2', spaceId: 'sp2', templateKey: null },
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
          { id: 'a1.m228', spaceId: 'exact', templateKey: null },
          { id: 'a1', spaceId: 'stripped', templateKey: null },
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
          { id: 'a1', spaceId: 'sp1', templateKey: 'shared.one' },
          { id: 'a2', spaceId: 'sp2', templateKey: 'shared.one' },
          { id: 'a3', spaceId: 'sp1', templateKey: 'shared.one' },
        ],
        workflowSlots: [
          { spaceId: 'sp3', templateKey: 'shared.one' },
          { spaceId: 'sp3', templateKey: 'shared.one' },
        ],
        auditEntries: [
          {
            spaceId: 'sp4',
            timestamp: 0,
            toolName: 'create_agent_template',
            paramsSummary: JSON.stringify({ key: 'shared.one' }),
          },
        ],
      })
    );
    const entry = evidence.get('shared.one');
    expect(entry?.agentReferenceSpaces).toEqual(['sp1', 'sp2']);
    expect(entry?.workflowSlotSpaces).toEqual(['sp3']);
    expect(entry?.auditedSpaces).toEqual(['sp4']);
  });

  test('ignores blank Space ids and blank template references', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'custom.one', createdAt: 0 }],
        agents: [{ id: 'a1', spaceId: '   ', templateKey: 'custom.one' }],
        workflowSlots: [{ spaceId: 'sp1', templateKey: '   ' }],
        auditEntries: [
          {
            spaceId: null,
            timestamp: 0,
            toolName: 'create_agent_template',
            paramsSummary: JSON.stringify({ key: 'custom.one' }),
          },
        ],
      })
    );
    const entry = evidence.get('custom.one');
    expect(entry?.agentReferenceSpaces).toEqual([]);
    expect(entry?.workflowSlotSpaces).toEqual([]);
    expect(entry?.auditedSpaces).toEqual([]);
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
  test('drops audit entries predating the current template row', () => {
    const evidence = collectTemplateOwnershipEvidence(
      inputs({
        templates: [{ key: 'shared.one', createdAt: 500 }],
        auditEntries: [
          {
            spaceId: 'former-owner',
            toolName: 'create_agent_template',
            timestamp: 100,
            paramsSummary: JSON.stringify({ key: 'shared.one' }),
          },
          {
            spaceId: 'current-owner',
            toolName: 'create_agent_template',
            timestamp: 500,
            paramsSummary: JSON.stringify({ key: 'shared.one' }),
          },
        ],
      })
    );
    expect(evidence.get('shared.one')?.auditedSpaces).toEqual(['current-owner']);
  });
});
