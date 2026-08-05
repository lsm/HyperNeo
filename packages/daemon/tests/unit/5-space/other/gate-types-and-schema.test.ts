/**
 * Gate Types and Schema Integration Tests
 *
 * Validates that:
 *   - Channel and Gate types are structurally correct
 *   - Gate definitions persist to and load from SQLite (workflow repository)
 *   - gate_data table supports CRUD via the repository
 *   - send_message schema accepts the optional `data` field
 *   - SpaceWorkflowRun supports failureReason
 *   - Gateless channels route without obstruction
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { SendMessageSchema } from '../../../../src/lib/space/tools/node-agent-tool-schemas.ts';
import type {
  Gate,
  Channel,
  WorkflowRunFailureReason,
  SpaceWorkflowRun,
  GateScript,
  GateField,
} from '@hyperneo/shared';
import { computeGateDefaults } from '@hyperneo/shared';
import { evaluateGate, validateGate } from '../../../../src/lib/space/runtime/gate-evaluator.ts';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

let db: Database;
const SPACE_ID = 'space-test-1';

function freshDb(): Database {
  const d = new Database(':memory:');
  createSpaceTables(d);
  const now = Date.now();
  d.exec(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test', 'Test Space', ${now}, ${now})`
  );
  return d;
}

beforeEach(() => {
  db = freshDb();
});

// ---------------------------------------------------------------------------
// Type validation — compile-time checks expressed as runtime assertions
// ---------------------------------------------------------------------------

describe('Gate and Channel type validation', () => {
  test('Channel without gateId is always open (type-level)', () => {
    const channel: Channel = {
      id: 'ch-1',
      from: 'planner',
      to: 'coder',
    };
    expect(channel.gateId).toBeUndefined();
  });

  test('Channel with gateId references a gate', () => {
    const channel: Channel = {
      id: 'ch-2',
      from: 'coder',
      to: 'reviewer',
      gateId: 'gate-approval',
      isCyclic: false,
      label: 'Code Review Gate',
    };
    expect(channel.gateId).toBe('gate-approval');
  });

  test('Gate with scalar field (boolean check)', () => {
    const gate: Gate = {
      id: 'gate-1',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
      ],
      resetOnCycle: false,
      description: 'Approval gate',
    };
    expect(gate.fields).toHaveLength(1);
    expect(gate.fields[0].name).toBe('approved');
  });

  test('Gate with map field (count check)', () => {
    const gate: Gate = {
      id: 'gate-2',
      fields: [
        {
          name: 'reviews',
          type: 'map',
          writers: ['reviewer-1', 'reviewer-2'],
          check: { op: 'count', match: 'approved', min: 2 },
        },
      ],
      resetOnCycle: true,
    };
    expect(gate.fields[0].type).toBe('map');
    expect(gate.fields[0].check.op).toBe('count');
  });

  test('Gate with multiple fields (all must pass)', () => {
    const gate: Gate = {
      id: 'gate-3',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        {
          name: 'reviews',
          type: 'map',
          writers: ['*'],
          check: { op: 'count', match: 'approved', min: 2 },
        },
      ],
      resetOnCycle: false,
    };
    expect(gate.fields).toHaveLength(2);
  });

  test('WorkflowRunFailureReason type accepts all valid values', () => {
    const reasons: WorkflowRunFailureReason[] = [
      'humanRejected',
      'maxIterationsReached',
      'nodeTimeout',
      'agentCrash',
    ];
    expect(reasons).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Workflow repository — gates persistence
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository — gates round-trip', () => {
  test('creates workflow with gates and retrieves them', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-approval',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
        description: 'Plan approval gate',
      },
      {
        id: 'gate-review-count',
        fields: [
          {
            name: 'approvals',
            type: 'map',
            writers: ['reviewer-1', 'reviewer-2'],
            check: { op: 'count', match: 'approved', min: 2 },
          },
        ],
        resetOnCycle: true,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Test Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toBeDefined();
    expect(workflow.gates).toHaveLength(2);
    expect(workflow.gates![0].id).toBe('gate-approval');
    expect(workflow.gates![0].fields[0].name).toBe('approved');
    expect(workflow.gates![1].id).toBe('gate-review-count');
    expect(workflow.gates![1].fields[0].check.op).toBe('count');
    expect(workflow.gates![1].resetOnCycle).toBe(true);
  });

  test('workflow without gates returns undefined gates', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'No Gates Workflow',
      completionAutonomyLevel: 3,
    });
    expect(workflow.gates).toBeUndefined();
  });

  test('updateWorkflow can set and clear gates', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Update Gates Test',
      completionAutonomyLevel: 3,
    });

    // Set gates
    const updated = workflowRepo.updateWorkflow(workflow.id, {
      gates: [
        {
          id: 'gate-1',
          fields: [
            { name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
          ],
          resetOnCycle: false,
        },
      ],
    });
    expect(updated!.gates).toHaveLength(1);

    // Clear gates
    const cleared = workflowRepo.updateWorkflow(workflow.id, { gates: null });
    expect(cleared!.gates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workflow repository — gates with label and color round-trip
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository — gates with label and color round-trip', () => {
  test('gate with label and color persists through createWorkflow', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-labeled',
        label: 'Code Review',
        color: '#22c55e',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Label Color Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toBeDefined();
    expect(workflow.gates).toHaveLength(1);
    expect(workflow.gates![0].id).toBe('gate-labeled');
    expect(workflow.gates![0].label).toBe('Code Review');
    expect(workflow.gates![0].color).toBe('#22c55e');
    expect(workflow.gates![0].fields).toHaveLength(1);
    expect(workflow.gates![0].fields![0].name).toBe('approved');
  });

  test('gate with label and color persists through updateWorkflow', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Update Label Color',
      gates: [
        {
          id: 'gate-1',
          fields: [
            {
              name: 'ready',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        },
      ],
      completionAutonomyLevel: 3,
    });

    // Update with label and color added
    const updated = workflowRepo.updateWorkflow(workflow.id, {
      gates: [
        {
          id: 'gate-1',
          label: 'Deploy Gate',
          color: '#ef4444',
          fields: [
            {
              name: 'ready',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        },
      ],
    });

    expect(updated!.gates).toHaveLength(1);
    expect(updated!.gates![0].label).toBe('Deploy Gate');
    expect(updated!.gates![0].color).toBe('#ef4444');
  });

  test('multiple gates with different labels and colors persist correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-review',
        label: 'Peer Review',
        color: '#3b82f6',
        fields: [
          {
            name: 'reviews',
            type: 'map',
            writers: ['reviewer-1', 'reviewer-2'],
            check: { op: 'count', match: 'approved', min: 2 },
          },
        ],
        resetOnCycle: false,
      },
      {
        id: 'gate-deploy',
        label: 'Deploy Approval',
        color: '#f59e0b',
        fields: [
          {
            name: 'deploy_ok',
            type: 'boolean',
            writers: ['ops'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'gate-qa',
        label: 'QA Passed',
        color: '#10b981',
        fields: [
          {
            name: 'qa_passed',
            type: 'boolean',
            writers: ['tester'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Multi Label Color',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toHaveLength(3);
    expect(workflow.gates![0].label).toBe('Peer Review');
    expect(workflow.gates![0].color).toBe('#3b82f6');
    expect(workflow.gates![1].label).toBe('Deploy Approval');
    expect(workflow.gates![1].color).toBe('#f59e0b');
    expect(workflow.gates![2].label).toBe('QA Passed');
    expect(workflow.gates![2].color).toBe('#10b981');
  });

  test('gate with label only (no color) persists through round-trip', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-label-only',
        label: 'Manual Check',
        fields: [
          {
            name: 'done',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Label Only Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates![0].label).toBe('Manual Check');
    expect(workflow.gates![0].color).toBeUndefined();
  });

  test('gate with color only (no label) persists through round-trip', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-color-only',
        color: '#8b5cf6',
        fields: [
          {
            name: 'passed',
            type: 'boolean',
            writers: ['system'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Color Only Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates![0].color).toBe('#8b5cf6');
    expect(workflow.gates![0].label).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workflow repository — gates with script round-trip
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository — gates with script round-trip', () => {
  test('gate with bash script persists through createWorkflow', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-bash',
        script: {
          interpreter: 'bash',
          source: 'make test && echo \'{"passed": true}\'',
          timeoutMs: 60000,
        },
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Bash Script Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toBeDefined();
    expect(workflow.gates).toHaveLength(1);
    expect(workflow.gates![0].script).toBeDefined();
    expect(workflow.gates![0].script!.interpreter).toBe('bash');
    expect(workflow.gates![0].script!.source).toBe('make test && echo \'{"passed": true}\'');
    expect(workflow.gates![0].script!.timeoutMs).toBe(60000);
  });

  test('gate with node script persists through createWorkflow', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-node',
        script: {
          interpreter: 'node',
          source: 'process.exit(0)',
        },
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Node Script Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates![0].script!.interpreter).toBe('node');
    expect(workflow.gates![0].script!.source).toBe('process.exit(0)');
    expect(workflow.gates![0].script!.timeoutMs).toBeUndefined();
  });

  test('gate with python3 script persists through createWorkflow', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-python',
        script: {
          interpreter: 'python3',
          source: 'import json; print(json.dumps({"ok": True}))',
          timeoutMs: 30000,
        },
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Python Script Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates![0].script!.interpreter).toBe('python3');
    expect(workflow.gates![0].script!.source).toBe('import json; print(json.dumps({"ok": True}))');
    expect(workflow.gates![0].script!.timeoutMs).toBe(30000);
  });

  test('gate with script and fields persists through round-trip', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-combined',
        label: 'Build + Tests',
        color: '#06b6d4',
        script: {
          interpreter: 'bash',
          source: 'make lint test',
          timeoutMs: 120000,
        },
        fields: [
          {
            name: 'tests_passed',
            type: 'boolean',
            writers: ['system'],
            check: { op: '==', value: true },
          },
          {
            name: 'coverage',
            type: 'number',
            writers: ['system'],
            check: { op: '==', value: 80 },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Combined Gate Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    const gate = workflow.gates![0];
    expect(gate.id).toBe('gate-combined');
    expect(gate.label).toBe('Build + Tests');
    expect(gate.color).toBe('#06b6d4');
    expect(gate.script!.interpreter).toBe('bash');
    expect(gate.script!.source).toBe('make lint test');
    expect(gate.script!.timeoutMs).toBe(120000);
    expect(gate.fields).toHaveLength(2);
    expect(gate.fields![0].name).toBe('tests_passed');
    expect(gate.fields![1].name).toBe('coverage');
  });

  test('gate with script persists through updateWorkflow round-trip', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Update Script Workflow',
      gates: [
        {
          id: 'gate-1',
          fields: [
            {
              name: 'ready',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        },
      ],
      completionAutonomyLevel: 3,
    });

    // Update: replace fields-only gate with script gate
    const updated = workflowRepo.updateWorkflow(workflow.id, {
      gates: [
        {
          id: 'gate-1',
          script: {
            interpreter: 'bash',
            source: 'npm run check',
          },
          resetOnCycle: false,
        },
      ],
    });

    expect(updated!.gates![0].script!.interpreter).toBe('bash');
    expect(updated!.gates![0].script!.source).toBe('npm run check');
    expect(updated!.gates![0].fields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workflow repository — script-only gate (no fields) round-trip
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository — script-only gate round-trip', () => {
  test('gate with script and no fields persists correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-script-only',
        script: {
          interpreter: 'bash',
          source: 'exit 0',
        },
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Script Only Workflow',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toBeDefined();
    expect(workflow.gates).toHaveLength(1);
    expect(workflow.gates![0].id).toBe('gate-script-only');
    expect(workflow.gates![0].script).toBeDefined();
    expect(workflow.gates![0].script!.interpreter).toBe('bash');
    expect(workflow.gates![0].script!.source).toBe('exit 0');
    expect(workflow.gates![0].fields).toBeUndefined();
  });

  test('script-only gate round-trips through getWorkflow after creation', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-no-fields',
        label: 'Lint Check',
        script: {
          interpreter: 'node',
          source: 'console.log("lint ok")',
          timeoutMs: 10000,
        },
        resetOnCycle: true,
      },
    ];

    const created = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Script Only Round-Trip',
      gates,
      completionAutonomyLevel: 3,
    });

    // Fetch fresh from DB
    const fetched = workflowRepo.getWorkflow(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.gates).toHaveLength(1);

    const gate = fetched!.gates![0];
    expect(gate.id).toBe('gate-no-fields');
    expect(gate.label).toBe('Lint Check');
    expect(gate.script!.interpreter).toBe('node');
    expect(gate.script!.source).toBe('console.log("lint ok")');
    expect(gate.script!.timeoutMs).toBe(10000);
    expect(gate.fields).toBeUndefined();
    expect(gate.resetOnCycle).toBe(true);
  });

  test('multiple script-only gates persist correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-lint',
        script: { interpreter: 'bash', source: 'eslint .' },
        resetOnCycle: false,
      },
      {
        id: 'gate-typecheck',
        script: { interpreter: 'node', source: 'tsc --noEmit', timeoutMs: 30000 },
        resetOnCycle: false,
      },
      {
        id: 'gate-format',
        script: { interpreter: 'python3', source: 'print("ok")' },
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Multi Script Gates',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toHaveLength(3);
    expect(workflow.gates![0].script!.interpreter).toBe('bash');
    expect(workflow.gates![1].script!.interpreter).toBe('node');
    expect(workflow.gates![2].script!.interpreter).toBe('python3');
    // None should have fields
    for (const gate of workflow.gates!) {
      expect(gate.fields).toBeUndefined();
    }
  });

  test('script-only gate can be updated to include fields', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Script To Fields',
      gates: [
        {
          id: 'gate-1',
          script: { interpreter: 'bash', source: 'exit 0' },
          resetOnCycle: false,
        },
      ],
      completionAutonomyLevel: 3,
    });

    // Update: add fields alongside script
    const updated = workflowRepo.updateWorkflow(workflow.id, {
      gates: [
        {
          id: 'gate-1',
          script: { interpreter: 'bash', source: 'exit 0' },
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: [],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        },
      ],
    });

    expect(updated!.gates![0].script!.interpreter).toBe('bash');
    expect(updated!.gates![0].fields).toHaveLength(1);
    expect(updated!.gates![0].fields![0].name).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Workflow run — failureReason persistence
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRunRepository — failureReason', () => {
  test('failureReason is undefined for normal runs', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'FR Test Workflow',
      completionAutonomyLevel: 3,
    });

    const runRepo = new SpaceWorkflowRunRepository(db);
    const run = runRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Test Run',
    });
    expect(run.failureReason).toBeUndefined();
  });

  test('failureReason persists through updateRun and round-trips correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'FR Persist Test',
      completionAutonomyLevel: 3,
    });

    const runRepo = new SpaceWorkflowRunRepository(db);
    const run = runRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Failure Test Run',
    });

    // Set failureReason
    const updated = runRepo.updateRun(run.id, {
      status: 'blocked',
      failureReason: 'maxIterationsReached',
    });
    expect(updated).not.toBeNull();
    expect(updated!.failureReason).toBe('maxIterationsReached');

    // Verify round-trip through getRun
    const fetched = runRepo.getRun(run.id);
    expect(fetched!.failureReason).toBe('maxIterationsReached');
  });

  test('failureReason can be cleared by setting to null', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'FR Clear Test',
      completionAutonomyLevel: 3,
    });

    const runRepo = new SpaceWorkflowRunRepository(db);
    const run = runRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Clear Test Run',
    });

    // Set then clear
    runRepo.updateRun(run.id, { failureReason: 'humanRejected' });
    const cleared = runRepo.updateRun(run.id, { failureReason: null });
    expect(cleared!.failureReason).toBeUndefined();
  });

  test('all four failureReason values persist correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'FR All Values',
      completionAutonomyLevel: 3,
    });
    const runRepo = new SpaceWorkflowRunRepository(db);

    const reasons: WorkflowRunFailureReason[] = [
      'humanRejected',
      'maxIterationsReached',
      'nodeTimeout',
      'agentCrash',
    ];

    for (const reason of reasons) {
      const run = runRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: `Run for ${reason}`,
      });
      runRepo.updateRun(run.id, { failureReason: reason });
      const fetched = runRepo.getRun(run.id);
      expect(fetched!.failureReason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate data — schema creation and CRUD
// ---------------------------------------------------------------------------

describe('gate_data table — schema and CRUD', () => {
  test('gate_data table exists and supports insert/select', () => {
    const repo = new GateDataRepository(db);

    // First create a workflow and run for FK
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'GD Test Workflow',
      completionAutonomyLevel: 3,
    });
    const runRepo = new SpaceWorkflowRunRepository(db);
    const run = runRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'GD Test Run',
    });

    // CRUD
    repo.set(run.id, 'gate-1', { approved: false });
    const record = repo.get(run.id, 'gate-1');
    expect(record).not.toBeNull();
    expect(record!.data).toEqual({ approved: false });

    // Merge
    repo.merge(run.id, 'gate-1', { approved: true });
    expect(repo.get(run.id, 'gate-1')!.data).toEqual({ approved: true });

    // Delete
    repo.delete(run.id, 'gate-1');
    expect(repo.get(run.id, 'gate-1')).toBeNull();
  });

  test('gate_data cascade deletes with workflow run', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);
    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Cascade Test',
      completionAutonomyLevel: 3,
    });
    const runRepo = new SpaceWorkflowRunRepository(db);
    const run = runRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Cascade Run',
    });

    const gateRepo = new GateDataRepository(db);
    gateRepo.set(run.id, 'gate-a', { value: 1 });
    gateRepo.set(run.id, 'gate-b', { value: 2 });

    // Delete the run
    runRepo.deleteRun(run.id);

    // Gate data should be gone (CASCADE)
    expect(gateRepo.listByRun(run.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// send_message schema — data field
// ---------------------------------------------------------------------------

describe('SendMessageSchema — data field', () => {
  test('accepts message without data', () => {
    const result = SendMessageSchema.safeParse({
      target: 'reviewer',
      message: 'Hello',
    });
    expect(result.success).toBe(true);
  });

  test('accepts message with data', () => {
    const result = SendMessageSchema.safeParse({
      target: 'reviewer',
      message: 'Approve please',
      data: { approved: true, score: 95 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data).toEqual({ approved: true, score: 95 });
    }
  });

  test('accepts message with empty data object', () => {
    const result = SendMessageSchema.safeParse({
      target: 'reviewer',
      message: 'No data',
      data: {},
    });
    expect(result.success).toBe(true);
  });

  test('rejects message with non-object data', () => {
    const result = SendMessageSchema.safeParse({
      target: 'reviewer',
      message: 'Bad data',
      data: 'not an object',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extended Gate interface: label, color, script, optional fields
// ---------------------------------------------------------------------------

describe('Gate extended interface (label, color, script, optional fields)', () => {
  test('Gate accepts label and color', () => {
    const gate: Gate = {
      id: 'gate-label-color',
      label: 'Code Review',
      color: '#22c55e',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
      ],
      resetOnCycle: false,
    };
    expect(gate.label).toBe('Code Review');
    expect(gate.color).toBe('#22c55e');
  });

  test('Gate accepts GateScript', () => {
    const script: GateScript = {
      interpreter: 'bash',
      source: 'echo "check passed"',
      timeoutMs: 5000,
    };
    const gate: Gate = {
      id: 'gate-script',
      script,
      resetOnCycle: false,
    };
    expect(gate.script).toBeDefined();
    expect(gate.script!.interpreter).toBe('bash');
    expect(gate.script!.source).toBe('echo "check passed"');
    expect(gate.script!.timeoutMs).toBe(5000);
  });

  test('GateScript accepts all interpreter types', () => {
    const interpreters: GateScript['interpreter'][] = ['bash', 'node', 'python3'];
    for (const interpreter of interpreters) {
      const script: GateScript = { interpreter, source: 'test' };
      expect(script.interpreter).toBe(interpreter);
    }
  });

  test('GateScript timeoutMs is optional', () => {
    const script: GateScript = {
      interpreter: 'node',
      source: 'console.log("ok")',
    };
    expect(script.timeoutMs).toBeUndefined();
  });

  test('Gate without fields compiles and fields is undefined', () => {
    const gate: Gate = {
      id: 'gate-no-fields',
      script: {
        interpreter: 'bash',
        source: 'exit 0',
      },
      resetOnCycle: false,
    };
    expect(gate.fields).toBeUndefined();
  });

  test('Gate with all new fields together', () => {
    const gate: Gate = {
      id: 'gate-full',
      description: 'Full gate',
      label: 'Build Check',
      color: '#ef4444',
      fields: [
        {
          name: 'build_passed',
          type: 'boolean',
          writers: ['builder'],
          check: { op: '==', value: true },
        },
      ],
      script: {
        interpreter: 'bash',
        source: 'make test',
        timeoutMs: 60000,
      },
      resetOnCycle: false,
    };
    expect(gate.label).toBe('Build Check');
    expect(gate.color).toBe('#ef4444');
    expect(gate.fields).toHaveLength(1);
    expect(gate.script!.interpreter).toBe('bash');
  });

  test('Gate with only label and no fields or script', () => {
    const gate: Gate = {
      id: 'gate-label-only',
      label: 'Manual Gate',
      resetOnCycle: false,
    };
    expect(gate.label).toBe('Manual Gate');
    expect(gate.fields).toBeUndefined();
    expect(gate.script).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeGateDefaults with optional fields
// ---------------------------------------------------------------------------

describe('computeGateDefaults with optional fields', () => {
  test('computeGateDefaults(undefined) returns empty object', () => {
    const result = computeGateDefaults(undefined);
    expect(result).toEqual({});
  });

  test('computeGateDefaults([]) returns empty object', () => {
    const result = computeGateDefaults([]);
    expect(result).toEqual({});
  });

  test('computeGateDefaults with map fields returns map defaults', () => {
    const fields: GateField[] = [
      {
        name: 'reviews',
        type: 'map',
        writers: ['reviewer-1', 'reviewer-2'],
        check: { op: 'count', match: 'approved', min: 2 },
      },
    ];
    const result = computeGateDefaults(fields);
    expect(result).toEqual({ reviews: {} });
  });

  test('computeGateDefaults with boolean fields returns empty (no key)', () => {
    const fields: GateField[] = [
      {
        name: 'approved',
        type: 'boolean',
        writers: [],
        check: { op: '==', value: true },
      },
    ];
    const result = computeGateDefaults(fields);
    expect(result).toEqual({});
  });

  test('computeGateDefaults with number fields returns empty (no key)', () => {
    const fields: GateField[] = [
      {
        name: 'coverage',
        type: 'number',
        writers: ['system'],
        check: { op: '==', value: 100 },
      },
    ];
    const result = computeGateDefaults(fields);
    expect(result).toEqual({});
  });

  test('computeGateDefaults with string fields returns empty (no key)', () => {
    const fields: GateField[] = [
      {
        name: 'status',
        type: 'string',
        writers: [],
        check: { op: 'exists' },
      },
    ];
    const result = computeGateDefaults(fields);
    expect(result).toEqual({});
  });

  test('computeGateDefaults with mixed fields returns only map defaults', () => {
    const fields: GateField[] = [
      {
        name: 'approved',
        type: 'boolean',
        writers: [],
        check: { op: '==', value: true },
      },
      {
        name: 'votes',
        type: 'map',
        writers: ['*'],
        check: { op: 'count', match: 'yes', min: 2 },
      },
      {
        name: 'comment',
        type: 'string',
        writers: [],
        check: { op: 'exists' },
      },
    ];
    const result = computeGateDefaults(fields);
    expect(result).toEqual({ votes: {} });
  });

  test('computeGateDefaults with multiple map fields returns all map defaults', () => {
    const fields: GateField[] = [
      {
        name: 'reviewer_votes',
        type: 'map',
        writers: [],
        check: { op: 'count', match: 'approved', min: 1 },
      },
      {
        name: 'tester_votes',
        type: 'map',
        writers: ['tester'],
        check: { op: 'count', match: 'passed', min: 1 },
      },
    ];
    const result = computeGateDefaults(fields);
    expect(result).toEqual({ reviewer_votes: {}, tester_votes: {} });
  });
});

// ---------------------------------------------------------------------------
// evaluateGate with optional fields
// ---------------------------------------------------------------------------

describe('evaluateGate with optional fields', () => {
  test('Gate with no fields evaluates as open', async () => {
    const gate: Gate = {
      id: 'gate-empty',
      resetOnCycle: false,
    };
    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('Gate with script-only (no fields) evaluates as open', async () => {
    // Note: evaluateGate does not execute gate.script when no scriptExecutor
    // is provided. A script-only gate opens trivially because there are no
    // fields to fail.
    const gate: Gate = {
      id: 'gate-script-only',
      script: {
        interpreter: 'bash',
        source: 'echo "ok"',
      },
      resetOnCycle: false,
    };
    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('Gate with fields still evaluates normally', async () => {
    const gate: Gate = {
      id: 'gate-with-fields',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
      ],
      resetOnCycle: false,
    };
    const result = await evaluateGate(gate, { approved: false });
    expect(result.open).toBe(false);
    const result2 = await evaluateGate(gate, { approved: true });
    expect(result2.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — existing gates without label/color/script
// ---------------------------------------------------------------------------

describe('Backward compatibility — gates without new fields round-trip', () => {
  test('gate with only id and fields (no label/color/script) round-trips unchanged', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-legacy',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Legacy Fields Gate',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toHaveLength(1);
    expect(workflow.gates![0].id).toBe('gate-legacy');
    expect(workflow.gates![0].label).toBeUndefined();
    expect(workflow.gates![0].color).toBeUndefined();
    expect(workflow.gates![0].script).toBeUndefined();
    expect(workflow.gates![0].fields).toHaveLength(1);
    expect(workflow.gates![0].fields![0].name).toBe('approved');
  });

  test('gate with id, description, and fields round-trips unchanged', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-desc',
        description: 'Legacy gate with description',
        fields: [
          {
            name: 'reviews',
            type: 'map',
            writers: ['reviewer-1', 'reviewer-2'],
            check: { op: 'count', match: 'approved', min: 2 },
          },
        ],
        resetOnCycle: true,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Legacy Desc Gate',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates![0].id).toBe('gate-desc');
    expect(workflow.gates![0].description).toBe('Legacy gate with description');
    expect(workflow.gates![0].label).toBeUndefined();
    expect(workflow.gates![0].color).toBeUndefined();
    expect(workflow.gates![0].script).toBeUndefined();
    expect(workflow.gates![0].resetOnCycle).toBe(true);
  });

  test('multiple legacy gates without new fields round-trip correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-a',
        fields: [
          {
            name: 'ready',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      },
      {
        id: 'gate-b',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['*'],
            check: { op: 'count', match: 'yes', min: 3 },
          },
        ],
        resetOnCycle: true,
      },
    ];

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Multi Legacy Gates',
      gates,
      completionAutonomyLevel: 3,
    });

    expect(workflow.gates).toHaveLength(2);
    for (const gate of workflow.gates!) {
      expect(gate.label).toBeUndefined();
      expect(gate.color).toBeUndefined();
      expect(gate.script).toBeUndefined();
    }
  });

  test('legacy gate round-trips through getWorkflow after creation', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const gates: Gate[] = [
      {
        id: 'gate-retrip',
        fields: [
          {
            name: 'done',
            type: 'boolean',
            writers: [],
            check: { op: 'exists' },
          },
        ],
        resetOnCycle: false,
      },
    ];

    const created = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Legacy Round-Trip',
      gates,
      completionAutonomyLevel: 3,
    });

    // Fetch fresh from DB
    const fetched = workflowRepo.getWorkflow(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.gates).toHaveLength(1);
    expect(fetched!.gates![0].id).toBe('gate-retrip');
    expect(fetched!.gates![0].fields).toHaveLength(1);
    expect(fetched!.gates![0].fields![0].name).toBe('done');
    expect(fetched!.gates![0].label).toBeUndefined();
    expect(fetched!.gates![0].color).toBeUndefined();
    expect(fetched!.gates![0].script).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateGate is creation-time only, not applied on load
// ---------------------------------------------------------------------------

describe('validateGate is creation-time only — not applied on load', () => {
  test('gate with fields:[] can be deserialized from storage without validateGate errors', () => {
    // Simulate what happens when a gate with fields:[] is loaded from storage:
    // The repository JSON.parse's the gates column — no validation is applied.
    const workflowRepo = new SpaceWorkflowRepository(db);

    // Insert a raw gate with fields:[] directly via SQL to simulate legacy data
    const now = Date.now();
    const workflowId = 'wf-legacy-empty-fields';
    const legacyGatesJson = JSON.stringify([
      { id: 'gate-empty-fields', fields: [], resetOnCycle: false },
    ]);

    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, channels, gates, layout, created_at, updated_at)
			 VALUES ('${workflowId}', '${SPACE_ID}', 'Legacy Empty Fields', '', NULL, '[]', NULL, '${legacyGatesJson.replace(/'/g, "''")}', NULL, ${now}, ${now})`
    );

    // The repository should load this without throwing
    const workflow = workflowRepo.getWorkflow(workflowId);
    expect(workflow).not.toBeNull();
    expect(workflow!.gates).toBeDefined();
    expect(workflow!.gates).toHaveLength(1);
    expect(workflow!.gates![0].id).toBe('gate-empty-fields');
    expect(workflow!.gates![0].fields).toEqual([]);
  });

  test('gate with no fields and no script loads from storage without errors', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const now = Date.now();
    const workflowId = 'wf-no-fields-no-script';
    const legacyGatesJson = JSON.stringify([{ id: 'gate-minimal', resetOnCycle: false }]);

    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, channels, gates, layout, created_at, updated_at)
			 VALUES ('${workflowId}', '${SPACE_ID}', 'Minimal Gate', '', NULL, '[]', NULL, '${legacyGatesJson.replace(/'/g, "''")}', NULL, ${now}, ${now})`
    );

    const workflow = workflowRepo.getWorkflow(workflowId);
    expect(workflow).not.toBeNull();
    expect(workflow!.gates).toHaveLength(1);
    expect(workflow!.gates![0].id).toBe('gate-minimal');
    expect(workflow!.gates![0].fields).toBeUndefined();
    expect(workflow!.gates![0].script).toBeUndefined();
  });

  test('validateGate rejects fields:[] at creation time but storage loading bypasses it', () => {
    // validateGate correctly rejects a gate with no fields and no script
    const errors = validateGate({ id: 'gate-bad', fields: [], resetOnCycle: false });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toContain(
      'gate: must have at least one non-empty "fields" array, "features", a "script", or a "validator"'
    );

    // But the repository will happily load such a gate from storage
    const workflowRepo = new SpaceWorkflowRepository(db);
    const now = Date.now();
    const workflowId = 'wf-validation-bypass';
    const legacyGatesJson = JSON.stringify([{ id: 'gate-bad', fields: [], resetOnCycle: false }]);

    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, channels, gates, layout, created_at, updated_at)
			 VALUES ('${workflowId}', '${SPACE_ID}', 'Validation Bypass', '', NULL, '[]', NULL, '${legacyGatesJson.replace(/'/g, "''")}', NULL, ${now}, ${now})`
    );

    const workflow = workflowRepo.getWorkflow(workflowId);
    expect(workflow).not.toBeNull();
    expect(workflow!.gates).toHaveLength(1);
    expect(workflow!.gates![0].id).toBe('gate-bad');
  });

  test('validateGate rejects gate with label > 20 chars', () => {
    const errors = validateGate({
      id: 'gate-long-label',
      label: 'This label is way too long for the gate badge display',
      fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
      resetOnCycle: false,
    });
    expect(errors).toContain('label: must be at most 20 characters, got 53');
  });

  test('validateGate rejects gate with invalid hex color', () => {
    const errors = validateGate({
      id: 'gate-bad-color',
      color: 'red',
      fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
      resetOnCycle: false,
    });
    expect(errors).toContain('color: expected hex format #rrggbb, got "red"');
  });

  test('validateGate rejects gate with invalid script interpreter', () => {
    const errors = validateGate({
      id: 'gate-bad-interp',
      script: { interpreter: 'ruby', source: 'puts "hello"' },
      resetOnCycle: false,
    });
    expect(errors).toContain(
      'script.interpreter: expected one of [bash, node, python3], got "ruby"'
    );
  });

  test('validateGate accepts gate with only a valid script (no fields)', () => {
    const errors = validateGate({
      id: 'gate-script-ok',
      script: { interpreter: 'bash', source: 'exit 0' },
      resetOnCycle: false,
    });
    expect(errors).toEqual([]);
  });

  test('validateGate accepts gate with fields, label, color, and script', () => {
    const errors = validateGate({
      id: 'gate-full-valid',
      label: 'Build Check',
      color: '#ef4444',
      script: { interpreter: 'bash', source: 'make test', timeoutMs: 30000 },
      fields: [
        { name: 'passed', type: 'boolean', writers: ['system'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    });
    expect(errors).toEqual([]);
  });

  test('mixed legacy and new gates load from storage correctly', () => {
    const workflowRepo = new SpaceWorkflowRepository(db);

    const now = Date.now();
    const workflowId = 'wf-mixed-gates';
    const mixedGatesJson = JSON.stringify([
      {
        id: 'gate-legacy',
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
        resetOnCycle: false,
      },
      { id: 'gate-empty', fields: [], resetOnCycle: false },
      {
        id: 'gate-new',
        label: 'New Gate',
        color: '#22c55e',
        script: { interpreter: 'bash', source: 'exit 0' },
        resetOnCycle: false,
      },
      { id: 'gate-minimal', resetOnCycle: true },
    ]);

    db.exec(
      `INSERT INTO space_workflows (id, space_id, name, description, start_node_id, tags, channels, gates, layout, created_at, updated_at)
			 VALUES ('${workflowId}', '${SPACE_ID}', 'Mixed Gates', '', NULL, '[]', NULL, '${mixedGatesJson.replace(/'/g, "''")}', NULL, ${now}, ${now})`
    );

    const workflow = workflowRepo.getWorkflow(workflowId);
    expect(workflow).not.toBeNull();
    expect(workflow!.gates).toHaveLength(4);

    // Legacy gate with fields
    expect(workflow!.gates![0].id).toBe('gate-legacy');
    expect(workflow!.gates![0].fields).toHaveLength(1);
    expect(workflow!.gates![0].label).toBeUndefined();

    // Empty fields gate (would fail validateGate but loads fine from storage)
    expect(workflow!.gates![1].id).toBe('gate-empty');
    expect(workflow!.gates![1].fields).toEqual([]);

    // New-style gate with label, color, and script
    expect(workflow!.gates![2].id).toBe('gate-new');
    expect(workflow!.gates![2].label).toBe('New Gate');
    expect(workflow!.gates![2].color).toBe('#22c55e');
    expect(workflow!.gates![2].script!.interpreter).toBe('bash');

    // Minimal gate
    expect(workflow!.gates![3].id).toBe('gate-minimal');
    expect(workflow!.gates![3].fields).toBeUndefined();
    expect(workflow!.gates![3].script).toBeUndefined();
  });
});
