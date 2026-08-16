/**
 * Export/Import Round-Trip Integration Tests
 *
 * Tests the full pipeline: exportWorkflow → validateExportBundle →
 * buildWorkflowCreateParams → SpaceWorkflowManager.createWorkflow → DB read-back.
 *
 * Verifies that per-slot override fields (role, model, systemPrompt, instructions) survive the
 * complete export → import cycle and are persisted correctly in the database.
 *
 * Also verifies backward compatibility: exports without per-slot override fields
 * (old format) import cleanly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  exportWorkflow,
  exportBundle,
  validateExportBundle,
} from '../../../src/lib/space/export-format.ts';
import { buildWorkflowCreateParams } from '../../../src/lib/rpc-handlers/space-export-import-handlers.ts';
import type { SpaceWorkerAgent, SpaceWorkflow, ExportedSpaceWorkflow } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTestAgent(
  id: string,
  name: string,
  overrides: Partial<SpaceWorkerAgent> = {}
): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name,
    customPrompt: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// End nodes must have exactly 1 agent (validator rule). Tests that exercise
// multi-agent steps append a downstream single-agent end node so the
// multi-agent step remains an intermediate node.
const SYNTHETIC_END_NODE = {
  id: '__test_end__',
  name: 'Synthetic End',
  agents: [{ agentId: 'agent-1', name: 'end' }],
};

function makeWorkflowWithOverrides(): SpaceWorkflow {
  return {
    id: 'wf-overrides',
    spaceId: 'space-1',
    name: 'Overrides Workflow',
    nodes: [
      {
        id: 'node-1',
        name: 'Parallel Review',
        agents: [
          {
            agentId: 'agent-1',
            name: 'strict-reviewer',
            customPrompt: { value: 'Review with extreme care.' },
          },
          {
            agentId: 'agent-2',
            name: 'quick-reviewer',
            customPrompt: { value: 'Review quickly.' },
          },
          {
            agentId: 'agent-1',
            name: 'coder',
            // no overrides — uses agent defaults
          },
        ],
      },
      SYNTHETIC_END_NODE,
    ],
    startNodeId: 'node-1',
    endNodeId: SYNTHETIC_END_NODE.id,
    tags: ['review'],
    createdAt: 1000,
    updatedAt: 2000,
  };
}

function makeWorkflowWithoutOverrides(): SpaceWorkflow {
  return {
    id: 'wf-basic',
    spaceId: 'space-1',
    name: 'Basic Workflow',
    nodes: [
      {
        id: 'node-1',
        name: 'Code Step',
        agents: [
          { agentId: 'agent-1', name: 'coder' },
          { agentId: 'agent-2', name: 'reviewer' },
        ],
      },
      SYNTHETIC_END_NODE,
    ],
    startNodeId: 'node-1',
    endNodeId: SYNTHETIC_END_NODE.id,
    tags: [],
    createdAt: 1000,
    updatedAt: 2000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildWorkflowCreateParams — per-slot overrides', () => {
  const agent1 = makeTestAgent('agent-1', 'Coder Agent');
  const agent2 = makeTestAgent('agent-2', 'Reviewer Agent');
  const agents = [agent1, agent2];

  test('maps customPrompt override to WorkflowNodeInput agents via export', () => {
    const workflow = makeWorkflowWithOverrides();
    const exported = exportWorkflow(workflow, agents);
    const exportedWf = exported;

    const importedNameToId = new Map([
      ['Coder Agent', 'new-agent-1'],
      ['Reviewer Agent', 'new-agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params } = buildWorkflowCreateParams(
      'space-import',
      'Overrides Workflow',
      exportedWf,
      importedNameToId,
      existingNameToId
    );

    const nodeAgents = params.nodes[0].agents!;
    expect(nodeAgents).toHaveLength(3);

    // strict-reviewer slot has customPrompt
    const strictReviewer = nodeAgents.find((a) => a.name === 'strict-reviewer');
    expect(strictReviewer).toBeDefined();
    expect(strictReviewer!.customPrompt).toBeDefined();

    // quick-reviewer slot has customPrompt
    const quickReviewer = nodeAgents.find((a) => a.name === 'quick-reviewer');
    expect(quickReviewer).toBeDefined();
    expect(quickReviewer!.customPrompt).toBeDefined();

    // coder slot has no overrides
    const coder = nodeAgents.find((a) => a.name === 'coder');
    expect(coder).toBeDefined();
    expect(coder!.customPrompt).toBeUndefined();
  });

  test('maps customPrompt override to WorkflowNodeInput agents', () => {
    const workflow = makeWorkflowWithOverrides();
    const exported = exportWorkflow(workflow, agents);

    const importedNameToId = new Map([
      ['Coder Agent', 'new-agent-1'],
      ['Reviewer Agent', 'new-agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params } = buildWorkflowCreateParams(
      'space-import',
      'Overrides Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );

    const nodeAgents = params.nodes[0].agents!;

    const strictReviewer = nodeAgents.find((a) => a.name === 'strict-reviewer');
    expect(strictReviewer!.customPrompt).toEqual({
      value: 'Review with extreme care.',
    });

    const quickReviewer = nodeAgents.find((a) => a.name === 'quick-reviewer');
    expect(quickReviewer!.customPrompt).toEqual({ value: 'Review quickly.' });

    const coder = nodeAgents.find((a) => a.name === 'coder');
    expect(coder!.customPrompt).toBeUndefined();
  });

  test('backward compat: imports agents without model/customPrompt cleanly', () => {
    const workflow = makeWorkflowWithoutOverrides();
    const exported = exportWorkflow(workflow, agents);

    const importedNameToId = new Map([
      ['Coder Agent', 'new-agent-1'],
      ['Reviewer Agent', 'new-agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      'space-import',
      'Basic Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );

    expect(warnings).toHaveLength(0);
    const nodeAgents = params.nodes[0].agents!;
    expect(nodeAgents).toHaveLength(2);

    // No overrides — model and customPrompt must be absent
    for (const a of nodeAgents) {
      expect(a.model).toBeUndefined();
      expect(a.customPrompt).toBeUndefined();
    }
  });

  test('preserves role field for each agent slot', () => {
    const workflow = makeWorkflowWithOverrides();
    const exported = exportWorkflow(workflow, agents);

    const importedNameToId = new Map([
      ['Coder Agent', 'new-agent-1'],
      ['Reviewer Agent', 'new-agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params } = buildWorkflowCreateParams(
      'space-import',
      'Overrides Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );

    const roles = params.nodes[0].agents!.map((a) => a.name);
    expect(roles).toContain('strict-reviewer');
    expect(roles).toContain('quick-reviewer');
    expect(roles).toContain('coder');
  });

  test('resolves agentRef names to new UUIDs on import', () => {
    const workflow = makeWorkflowWithOverrides();
    const exported = exportWorkflow(workflow, agents);

    const importedNameToId = new Map([
      ['Coder Agent', 'imported-uuid-1'],
      ['Reviewer Agent', 'imported-uuid-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      'space-import',
      'Overrides Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );

    expect(warnings).toHaveLength(0);
    const nodeAgents = params.nodes[0].agents!;

    // Both agents resolve to their new UUIDs
    for (const a of nodeAgents) {
      expect(a.agentId).toBeTruthy();
      expect(a.agentId).not.toBe('');
      expect(['imported-uuid-1', 'imported-uuid-2']).toContain(a.agentId);
    }
  });

  test('maps instructions field (legacy) to customPrompt in WorkflowNodeInput agents', () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-instr',
      spaceId: 'space-1',
      name: 'Instructions Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Step',
          agents: [
            {
              agentId: 'agent-1',
              name: 'coder',
              // Use customPrompt directly (new format)
              customPrompt: { value: 'Focus on auth module only.' },
            },
            {
              agentId: 'agent-2',
              name: 'reviewer',
              // no overrides
            },
          ],
        },
      ],
      transitions: [],
      startNodeId: 'node-1',
      rules: [],
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const exported = exportWorkflow(workflow, agents);

    const importedNameToId = new Map([
      ['Coder Agent', 'new-agent-1'],
      ['Reviewer Agent', 'new-agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      'space-import',
      'Instructions Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );

    expect(warnings).toHaveLength(0);
    const nodeAgents = params.nodes[0].agents!;

    const coder = nodeAgents.find((a) => a.name === 'coder');
    expect(coder!.customPrompt).toEqual({ value: 'Focus on auth module only.' });

    const reviewer = nodeAgents.find((a) => a.name === 'reviewer');
    expect(reviewer!.customPrompt).toBeUndefined();
  });

  test('warns when agentRef cannot be resolved', () => {
    const workflow = makeWorkflowWithoutOverrides();
    const exported = exportWorkflow(workflow, agents);

    // Only provide one agent — the other will be unresolvable
    const importedNameToId = new Map([['Coder Agent', 'uuid-1']]);
    const existingNameToId = new Map<string, string>();

    const { warnings } = buildWorkflowCreateParams(
      'space-import',
      'Basic Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Reviewer Agent');
  });
});

// -------------------------------------------------------------------------
// legacy plain-string overrides — import normalization
// -------------------------------------------------------------------------

test('normalizes legacy plain-string systemPrompt to { value } on import (maps to customPrompt)', () => {
  const legacyExported: ExportedSpaceWorkflow = {
    version: 1,
    type: 'workflow',
    name: 'Legacy Workflow',
    nodes: [
      {
        name: 'Step',
        agents: [{ agentRef: 'Coder Agent', name: 'coder', systemPrompt: 'Be strict.' }],
      },
    ],
    startNode: 'Step',
    tags: [],
  };

  const importedNameToId = new Map([['Coder Agent', 'new-agent-1']]);
  const existingNameToId = new Map<string, string>();

  const { params, warnings } = buildWorkflowCreateParams(
    'space-import',
    'Legacy Workflow',
    legacyExported,
    importedNameToId,
    existingNameToId
  );

  expect(warnings).toHaveLength(0);
  const nodeAgents = params.nodes[0].agents!;
  // Legacy plain-string systemPrompt is normalized to { value } and mapped to customPrompt
  expect(nodeAgents[0].customPrompt).toEqual({ value: 'Be strict.' });
});

test('normalizes legacy plain-string instructions to { value } on import (maps to customPrompt)', () => {
  const legacyExported: ExportedSpaceWorkflow = {
    version: 1,
    type: 'workflow',
    name: 'Legacy Workflow',
    nodes: [
      {
        name: 'Step',
        agents: [
          { agentRef: 'Reviewer Agent', name: 'reviewer', instructions: 'Review carefully.' },
        ],
      },
    ],
    startNode: 'Step',
    tags: [],
  };

  const importedNameToId = new Map([['Reviewer Agent', 'new-agent-2']]);
  const existingNameToId = new Map<string, string>();

  const { params, warnings } = buildWorkflowCreateParams(
    'space-import',
    'Legacy Workflow',
    legacyExported,
    importedNameToId,
    existingNameToId
  );

  expect(warnings).toHaveLength(0);
  const nodeAgents = params.nodes[0].agents!;
  // Legacy plain-string instructions is normalized to { value } and mapped to customPrompt
  expect(nodeAgents[0].customPrompt).toEqual({ value: 'Review carefully.' });
});

test('{ value } objects (systemPrompt) pass through to customPrompt', () => {
  const legacyExported: ExportedSpaceWorkflow = {
    version: 1,
    type: 'workflow',
    name: 'Modern Workflow',
    nodes: [
      {
        name: 'Step',
        agents: [
          {
            agentRef: 'Coder Agent',
            name: 'coder',
            systemPrompt: { value: 'Extra context.' },
            instructions: { value: 'Follow these rules.' },
          },
        ],
      },
    ],
    startNode: 'Step',
    tags: [],
  };

  const importedNameToId = new Map([['Coder Agent', 'new-agent-1']]);
  const existingNameToId = new Map<string, string>();

  const { params, warnings } = buildWorkflowCreateParams(
    'space-import',
    'Modern Workflow',
    legacyExported,
    importedNameToId,
    existingNameToId
  );

  expect(warnings).toHaveLength(0);
  const nodeAgents = params.nodes[0].agents!;
  // systemPrompt + instructions both map to customPrompt (combined with \n\n)
  expect(nodeAgents[0].customPrompt).toEqual({ value: 'Extra context.\n\nFollow these rules.' });
});

test('mix of plain strings and { value } objects in the same node normalize to customPrompt correctly', () => {
  const legacyExported: ExportedSpaceWorkflow = {
    version: 1,
    type: 'workflow',
    name: 'Mixed Workflow',
    nodes: [
      {
        name: 'Step',
        agents: [
          {
            agentRef: 'Coder Agent',
            name: 'coder',
            systemPrompt: 'Plain string prompt',
          },
          {
            agentRef: 'Reviewer Agent',
            name: 'reviewer',
            systemPrompt: { value: 'Modern prompt' },
          },
        ],
      },
    ],
    startNode: 'Step',
    tags: [],
  };

  const importedNameToId = new Map([
    ['Coder Agent', 'new-agent-1'],
    ['Reviewer Agent', 'new-agent-2'],
  ]);
  const existingNameToId = new Map<string, string>();

  const { params, warnings } = buildWorkflowCreateParams(
    'space-import',
    'Mixed Workflow',
    legacyExported,
    importedNameToId,
    existingNameToId
  );

  expect(warnings).toHaveLength(0);
  const nodeAgents = params.nodes[0].agents!;

  // coder: plain string systemPrompt normalized to { value }
  const coder = nodeAgents.find((a) => a.name === 'coder')!;
  expect(coder.customPrompt).toEqual({ value: 'Plain string prompt' });

  // reviewer: { value } systemPrompt passed through unchanged
  const reviewer = nodeAgents.find((a) => a.name === 'reviewer')!;
  expect(reviewer.customPrompt).toEqual({ value: 'Modern prompt' });
});

// ---------------------------------------------------------------------------
// Full round-trip: export → validate → import → DB read-back
// ---------------------------------------------------------------------------

describe('full round-trip: export → import → DB read-back', () => {
  let db: BunDatabase;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;

  const SPACE_ID = 'space-rt';

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID);
    seedAgent(db, 'agent-1', SPACE_ID, 'Coder Agent');
    seedAgent(db, 'agent-2', SPACE_ID, 'Reviewer Agent');
    repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo);
  });

  afterEach(() => {
    db.close();
  });

  test('per-slot systemPrompt override persists after import', () => {
    const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
    const agent2 = makeTestAgent('agent-2', 'Reviewer Agent', { spaceId: SPACE_ID });
    const agents = [agent1, agent2];

    const originalWorkflow = makeWorkflowWithOverrides();
    originalWorkflow.spaceId = SPACE_ID;

    // Export
    const exported = exportWorkflow(originalWorkflow, agents);
    const bundle = exportBundle(agents, [originalWorkflow], 'Test Bundle');

    // Validate (simulates the import pipeline's validation step)
    const validation = validateExportBundle(bundle);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    // Build import params with the exported workflow
    const importedNameToId = new Map([
      ['Coder Agent', 'agent-1'],
      ['Reviewer Agent', 'agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      SPACE_ID,
      'Overrides Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );
    expect(warnings).toHaveLength(0);

    // Create workflow via manager (same path as spaceImport.execute)
    const created = manager.createWorkflow(params);

    // Read back from DB and verify per-slot overrides are persisted
    const readBack = repo.getWorkflow(created.id);
    expect(readBack).not.toBeNull();
    const nodeAgents = readBack!.nodes[0].agents!;
    expect(nodeAgents).toHaveLength(3);

    const strictReviewer = nodeAgents.find((a) => a.name === 'strict-reviewer');
    expect(strictReviewer).toBeDefined();
    expect(strictReviewer!.customPrompt).toEqual({
      value: 'Review with extreme care.',
    });

    const quickReviewer = nodeAgents.find((a) => a.name === 'quick-reviewer');
    expect(quickReviewer).toBeDefined();
    expect(quickReviewer!.customPrompt).toEqual({ value: 'Review quickly.' });

    const coder = nodeAgents.find((a) => a.name === 'coder');
    expect(coder).toBeDefined();
    expect(coder!.customPrompt).toBeUndefined();
  });

  test('backward compat: old export without overrides imports and persists cleanly', () => {
    const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
    const agent2 = makeTestAgent('agent-2', 'Reviewer Agent', { spaceId: SPACE_ID });
    const agents = [agent1, agent2];

    const originalWorkflow = makeWorkflowWithoutOverrides();
    originalWorkflow.spaceId = SPACE_ID;

    // Simulate an old export: export normally (no overrides in source)
    const exported = exportWorkflow(originalWorkflow, agents);

    // Verify exported format has no model/systemPrompt
    const entry0 = exported.nodes[0].agents![0] as Record<string, unknown>;
    expect('model' in entry0).toBe(false);
    expect('systemPrompt' in entry0).toBe(false);

    // Build import params
    const importedNameToId = new Map([
      ['Coder Agent', 'agent-1'],
      ['Reviewer Agent', 'agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      SPACE_ID,
      'Basic Workflow',
      exported,
      importedNameToId,
      existingNameToId
    );
    expect(warnings).toHaveLength(0);

    // Import and read back — should succeed without errors
    const created = manager.createWorkflow(params);
    const readBack = repo.getWorkflow(created.id);
    expect(readBack).not.toBeNull();

    const nodeAgents = readBack!.nodes[0].agents!;
    expect(nodeAgents).toHaveLength(2);

    // No overrides stored — customPrompt should be absent/undefined
    for (const a of nodeAgents) {
      expect(a.customPrompt).toBeUndefined();
    }
  });

  test('same agent added multiple times with different customPrompt overrides', () => {
    const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
    const agents = [agent1];

    // Same agent twice in one node, different per-slot configs
    const workflow: SpaceWorkflow = {
      id: 'wf-same-agent',
      spaceId: SPACE_ID,
      name: 'Same Agent Twice',
      nodes: [
        {
          id: 'node-1',
          name: 'Multi Slot',
          agents: [
            {
              agentId: 'agent-1',
              name: 'strict-coder',
              customPrompt: { value: 'Write perfect code.' },
            },
            {
              agentId: 'agent-1',
              name: 'fast-coder',
              customPrompt: { value: 'Write quick code.' },
            },
          ],
        },
        SYNTHETIC_END_NODE,
      ],
      startNodeId: 'node-1',
      endNodeId: SYNTHETIC_END_NODE.id,
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const exported = exportWorkflow(workflow, agents);

    // Verify both slots exported with distinct overrides
    const exportedAgents = exported.nodes[0].agents!;
    expect(exportedAgents).toHaveLength(2);
    expect(exportedAgents[0].agentRef).toBe('Coder Agent');
    expect(exportedAgents[0].name).toBe('strict-coder');
    expect(exportedAgents[0].systemPrompt).toEqual({
      value: 'Write perfect code.',
    });
    expect(exportedAgents[1].agentRef).toBe('Coder Agent');
    expect(exportedAgents[1].name).toBe('fast-coder');
    expect(exportedAgents[1].systemPrompt).toEqual({
      value: 'Write quick code.',
    });

    // Build import params and persist
    const importedNameToId = new Map([['Coder Agent', 'agent-1']]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      SPACE_ID,
      'Same Agent Twice',
      exported,
      importedNameToId,
      existingNameToId
    );
    expect(warnings).toHaveLength(0);

    const created = manager.createWorkflow(params);
    const readBack = repo.getWorkflow(created.id);
    expect(readBack).not.toBeNull();

    const nodeAgents = readBack!.nodes[0].agents!;
    expect(nodeAgents).toHaveLength(2);

    const strictCoder = nodeAgents.find((a) => a.name === 'strict-coder');
    expect(strictCoder!.agentId).toBe('agent-1');
    expect(strictCoder!.customPrompt).toEqual({ value: 'Write perfect code.' });

    const fastCoder = nodeAgents.find((a) => a.name === 'fast-coder');
    expect(fastCoder!.agentId).toBe('agent-1');
    expect(fastCoder!.customPrompt).toEqual({ value: 'Write quick code.' });
  });

  test('customPrompt per-slot override persists after import (DB round-trip)', () => {
    const agent1 = makeTestAgent('agent-1', 'Coder Agent', { spaceId: SPACE_ID });
    const agent2 = makeTestAgent('agent-2', 'Reviewer Agent', { spaceId: SPACE_ID });
    const agents = [agent1, agent2];

    const workflow: SpaceWorkflow = {
      id: 'wf-instr',
      spaceId: SPACE_ID,
      name: 'CustomPrompt Round Trip',
      nodes: [
        {
          id: 'node-1',
          name: 'Step',
          agents: [
            {
              agentId: 'agent-1',
              name: 'coder',
              customPrompt: { value: 'Focus on auth module only.' },
            },
            {
              agentId: 'agent-2',
              name: 'reviewer',
              // no overrides
            },
          ],
        },
        SYNTHETIC_END_NODE,
      ],
      transitions: [],
      startNodeId: 'node-1',
      endNodeId: SYNTHETIC_END_NODE.id,
      rules: [],
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const exported = exportWorkflow(workflow, agents);

    const importedNameToId = new Map([
      ['Coder Agent', 'agent-1'],
      ['Reviewer Agent', 'agent-2'],
    ]);
    const existingNameToId = new Map<string, string>();

    const { params, warnings } = buildWorkflowCreateParams(
      SPACE_ID,
      'CustomPrompt Round Trip',
      exported,
      importedNameToId,
      existingNameToId
    );
    expect(warnings).toHaveLength(0);

    const created = manager.createWorkflow(params);
    const readBack = repo.getWorkflow(created.id);
    expect(readBack).not.toBeNull();

    const nodeAgents = readBack!.nodes[0].agents!;
    const coder = nodeAgents.find((a) => a.name === 'coder');
    expect(coder!.customPrompt).toEqual({ value: 'Focus on auth module only.' });

    const reviewer = nodeAgents.find((a) => a.name === 'reviewer');
    expect(reviewer!.customPrompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateExportBundle — duplicate handle detection
// ---------------------------------------------------------------------------

describe('validateExportBundle — duplicate handle within bundle', () => {
  /** Minimal valid exported workflow fixture with an optional handle. */
  function makeExportedWf(name: string, handle?: string): ExportedSpaceWorkflow {
    return {
      version: 1,
      type: 'workflow',
      name,
      nodes: [{ name: 'Work', agents: [{ agentRef: 'Coder', name: 'coder' }] }],
      startNode: 'Work',
      tags: [],
      completionAutonomyLevel: 3,
      ...(handle !== undefined ? { handle } : {}),
    } as ExportedSpaceWorkflow;
  }

  test('rejects two workflows in the same bundle that share a handle', () => {
    const bundle = exportBundle([], [], 'Collision Bundle');
    // Manually inject two workflows with the same handle
    (bundle as Record<string, unknown>).workflows = [
      makeExportedWf('Workflow A', 'shared-handle'),
      makeExportedWf('Workflow B', 'shared-handle'),
    ];
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('duplicate handle');
      expect(result.error).toContain('shared-handle');
    }
  });

  test('accepts a bundle where all workflow handles are unique', () => {
    const bundle = exportBundle([], [], 'Clean Bundle');
    (bundle as Record<string, unknown>).workflows = [
      makeExportedWf('Workflow A', 'handle-a'),
      makeExportedWf('Workflow B', 'handle-b'),
    ];
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(true);
  });

  test('accepts a bundle where some workflows have no handle', () => {
    const bundle = exportBundle([], [], 'Partial Handles Bundle');
    (bundle as Record<string, unknown>).workflows = [
      makeExportedWf('Workflow A', 'handle-a'),
      makeExportedWf('Workflow B'), // no handle
      makeExportedWf('Workflow C'), // no handle — no conflict since null is not unique-checked
    ];
    const result = validateExportBundle(bundle);
    expect(result.ok).toBe(true);
  });
});
