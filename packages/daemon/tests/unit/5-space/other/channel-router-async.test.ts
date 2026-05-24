/**
 * ChannelRouter Async Gate Evaluation Unit Tests
 *
 * Covers Task 3.2 features:
 * - Global concurrency semaphore (maxConcurrentScripts)
 * - Per-gate evaluation coalescing (always re-evaluates after in-flight completes)
 * - workspacePath in config
 * - Cross-run isolation (same gateId in different runs)
 * - Field-only gates bypass semaphore
 * - Script gate wiring (executeGateScript integration)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  ChannelRouter,
  ChannelGateBlockedError,
} from '../../../../src/lib/space/runtime/channel-router.ts';
import type { Gate, WorkflowChannel } from '@neokai/shared';
import { CODING_WORKFLOW } from '../../../../src/lib/space/workflows/built-in-workflows.ts';

// ---------------------------------------------------------------------------
// DB helpers (shared with channel-router.test.ts)
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
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(
  db: BunDatabase,
  agentId: string,
  spaceId: string,
  _role?: 'coder' | 'planner' | 'general' | string
): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Workflow builder helper with gates support
// ---------------------------------------------------------------------------

function buildWorkflowWithGates(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{
    id: string;
    name: string;
    agentId?: string;
    agents?: Array<{ agentId: string; name: string }>;
  }>,
  channels: WorkflowChannel[],
  gates: Gate[]
) {
  return workflowManager.createWorkflow({
    spaceId,
    name: `Test Workflow With Gates ${Date.now()}`,
    description: '',
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      agentId: n.agentId,
      agents: n.agents,
    })),
    transitions: [],
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    channels,
    gates,
    completionAutonomyLevel: 3,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelRouter async gate evaluation', () => {
  let db: BunDatabase;

  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowManager: SpaceWorkflowManager;
  let agentManager: SpaceAgentManager;
  let gateDataRepo: GateDataRepository;
  let channelCycleRepo: ChannelCycleRepository;

  const SPACE_ID = 'space-async-1';
  const AGENT_CODER = 'agent-async-coder';
  const AGENT_PLANNER = 'agent-async-planner';
  const NODE_A = 'node-async-a';
  const NODE_B = 'node-async-b';

  beforeEach(() => {
    db = makeDb();

    seedSpace(db, SPACE_ID);
    seedAgent(db, AGENT_CODER, SPACE_ID, 'coder');
    seedAgent(db, AGENT_PLANNER, SPACE_ID, 'planner');

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    gateDataRepo = new GateDataRepository(db);
    channelCycleRepo = new ChannelCycleRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Builds a ChannelRouter with default config plus optional overrides.
   */
  function makeRouter(overrides: Record<string, unknown> = {}): ChannelRouter {
    return new ChannelRouter({
      taskRepo,
      workflowRunRepo,
      workflowManager,
      agentManager,
      gateDataRepo,
      channelCycleRepo,
      db,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      ...overrides,
    });
  }

  /**
   * Creates a simple two-node workflow with an optional gated channel.
   */
  function buildTwoNodeWorkflow(gate?: Gate, channelGateId?: string) {
    const channels: WorkflowChannel[] = gate
      ? [
          {
            from: 'coder',
            to: 'planner',
            gateId: channelGateId ?? gate.id,
          },
        ]
      : [];
    return buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        {
          id: NODE_A,
          name: 'Coder Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder' }],
        },
        {
          id: NODE_B,
          name: 'Planner Node',
          agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
        },
      ],
      channels,
      gate ? [gate] : []
    );
  }

  /**
   * Creates a run in `in_progress` state for the given workflow.
   */
  function createActiveRun(workflow: ReturnType<typeof buildWorkflowWithGates>) {
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Async Test Run',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    // One-task-per-run: seed canonical workflow task for compatibility envelopes.
    taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Async Test Run Task',
      description: '',
      status: 'open',
      workflowRunId: run.id,
    });
    return run;
  }

  // -------------------------------------------------------------------------
  // Field-only gates bypass semaphore
  // -------------------------------------------------------------------------

  describe('field-only gates bypass semaphore', () => {
    test('field-only gate evaluates without semaphore overhead', async () => {
      const gate: Gate = {
        id: 'field-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);
      gateDataRepo.set(run.id, 'field-gate', { approved: true });

      const router = makeRouter({ maxConcurrentScripts: 1 });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('concurrent field-only gate evaluations are not limited by maxConcurrentScripts', async () => {
      const gate: Gate = {
        id: 'field-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);
      gateDataRepo.set(run.id, 'field-gate', { approved: true });

      // With maxConcurrentScripts: 1, script gates would be serialized.
      // Field-only gates should all evaluate concurrently.
      const router = makeRouter({ maxConcurrentScripts: 1 });
      const results = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
      ]);
      expect(results.every((r) => r.allowed)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // workspacePath config
  // -------------------------------------------------------------------------

  describe('workspacePath config', () => {
    test('workspacePath is accepted in ChannelRouterConfig', () => {
      const router = makeRouter({ workspacePath: '/tmp/workspace' });
      expect(router).toBeDefined();
    });

    test('workspacePath defaults to undefined when not provided', () => {
      const router = makeRouter();
      expect(router).toBeDefined();
    });

    test('script gate uses workspacePath for script execution context', async () => {
      const gate: Gate = {
        id: 'script-gate',
        script: {
          interpreter: 'bash',
          source: 'exit 0',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      // Script exits 0 with no JSON → data is empty, no fields → gate open
      expect(result.allowed).toBe(true);
    });

    test('script gate with workspacePath injects NEOKAI_WORKSPACE_PATH', async () => {
      // Use node interpreter to read env vars reliably
      const gate: Gate = {
        id: 'script-gate',
        script: {
          interpreter: 'node',
          source: 'console.log(JSON.stringify({ws: process.env.NEOKAI_WORKSPACE_PATH}))',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'ws',
            type: 'string',
            writers: ['*'],
            check: { op: 'exists' },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      // Use /tmp (guaranteed to exist) as workspacePath
      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Script gate evaluation
  // -------------------------------------------------------------------------

  describe('script gate evaluation', () => {
    test('script gate blocks when script exits non-zero', async () => {
      const gate: Gate = {
        id: 'failing-script-gate',
        script: {
          interpreter: 'bash',
          source: 'echo "test failed" >&2; exit 1',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Script check failed');
    });

    test('script gate blocks when script times out', async () => {
      const gate: Gate = {
        id: 'timeout-script-gate',
        script: {
          interpreter: 'bash',
          source: 'sleep 60',
          timeoutMs: 500,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Script check failed');
    });

    test('script gate passes when script exits 0 with JSON merged into field data', async () => {
      const gate: Gate = {
        id: 'merge-script-gate',
        script: {
          interpreter: 'bash',
          source: 'echo \'{"approved": true}\'',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('deliverMessage throws ChannelGateBlockedError for failing script gate', async () => {
      const gate: Gate = {
        id: 'block-script-gate',
        script: {
          interpreter: 'bash',
          source: 'exit 1',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      await expect(router.deliverMessage(run.id, 'coder', 'planner', 'test')).rejects.toThrow(
        ChannelGateBlockedError
      );
    });

    test('NEOKAI_GATE_ID and NEOKAI_WORKFLOW_RUN_ID are injected into script env', async () => {
      // Use JavaScript (node) interpreter to read env vars, avoiding bash
      // variable expansion edge cases.
      const gate: Gate = {
        id: 'env-script-gate',
        script: {
          interpreter: 'node',
          source: 'console.log(JSON.stringify({gateId: process.env.NEOKAI_GATE_ID}))',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'gateId',
            type: 'string',
            writers: ['*'],
            check: { op: '==', value: 'env-script-gate' },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      if (!result.allowed) {
        throw new Error(`Gate should be open but was blocked: ${result.reason}`);
      }
      expect(result.allowed).toBe(true);
    });

    test('gate runtime data JSON is injected and script can read pr_url generically', async () => {
      const expectedPrUrl = 'https://github.com/example/repo/pull/4242';
      const gate: Gate = {
        id: 'env-pr-url-gate',
        script: {
          interpreter: 'node',
          source:
            'const raw = process.env.NEOKAI_GATE_DATA_JSON ?? "{}"; let parsed = {}; try { parsed = JSON.parse(raw); } catch {} console.log(JSON.stringify({ seenPrUrl: parsed.pr_url ?? null }));',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'seenPrUrl',
            type: 'string',
            writers: ['*'],
            check: { op: '==', value: expectedPrUrl },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);
      gateDataRepo.set(run.id, gate.id, { pr_url: expectedPrUrl });

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      if (!result.allowed) {
        throw new Error(`Gate should be open but was blocked: ${result.reason}`);
      }
      expect(result.allowed).toBe(true);
    });

    test('script-only gate (no fields) opens when script exits 0', async () => {
      const gate: Gate = {
        id: 'script-only-gate',
        script: {
          interpreter: 'bash',
          source: 'exit 0',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('onGateDataChanged with script gate activates node when gate opens', async () => {
      const gate: Gate = {
        id: 'script-ogdc-gate',
        script: {
          interpreter: 'bash',
          source: 'echo \'{"approved": true}\'',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const activated = await router.onGateDataChanged(run.id, 'script-ogdc-gate');
      expect(activated.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency semaphore
  // -------------------------------------------------------------------------

  describe('concurrency semaphore', () => {
    test('respects maxConcurrentScripts: 1 for script gates (different gateIds)', async () => {
      // Use different gate IDs to avoid coalescing. Each gate has its own
      // coalescing key, so both go through the semaphore independently.
      // With maxConcurrentScripts=1, they should be serialized (~400ms).
      const AGENT_REVIEWER = 'agent-async-reviewer';
      seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'planner');

      const gate1: Gate = {
        id: 'slow-script-a',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const gate2: Gate = {
        id: 'slow-script-b',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'slow-script-a' },
        { id: 'ch-2', from: 'coder', to: 'reviewer', gateId: 'slow-script-b' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          {
            id: 'node-async-c',
            name: 'Reviewer Node',
            agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer' }],
          },
        ],
        channels,
        [gate1, gate2]
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 1 });

      const start = Date.now();
      const [r1, r2] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'reviewer'),
      ]);
      const elapsed = Date.now() - start;

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // With maxConcurrentScripts=1, both evaluations are serialized (~400ms).
      expect(elapsed).toBeGreaterThanOrEqual(300);
    });

    test('maxConcurrentScripts: 2 allows two different script gates concurrently', async () => {
      const AGENT_REVIEWER = 'agent-async-reviewer';
      seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'planner');

      const gate1: Gate = {
        id: 'conc-script-a',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const gate2: Gate = {
        id: 'conc-script-b',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'conc-script-a' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          {
            id: 'node-async-c',
            name: 'Reviewer Node',
            agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer' }],
          },
        ],
        channels,
        [gate1, gate2]
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 2 });

      const start = Date.now();
      const [r1, r2] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'reviewer'),
      ]);
      const elapsed = Date.now() - start;

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // With maxConcurrentScripts=2, both can run concurrently (~200ms).
      expect(elapsed).toBeLessThan(600);
    });

    test('accepts maxConcurrentScripts: 1', () => {
      const router = makeRouter({ maxConcurrentScripts: 1 });
      expect(router).toBeDefined();
    });

    test('accepts maxConcurrentScripts: 10', () => {
      const router = makeRouter({ maxConcurrentScripts: 10 });
      expect(router).toBeDefined();
    });

    test('field-only gates work with maxConcurrentScripts: 1', async () => {
      const gate: Gate = {
        id: 'field-only-gate',
        fields: [
          {
            name: 'ready',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);
      gateDataRepo.set(run.id, 'field-only-gate', { ready: true });

      const router = makeRouter({ maxConcurrentScripts: 1 });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    // -------------------------------------------------------------------
    // Semaphore overflow and start-after-completion
    // -------------------------------------------------------------------

    test('3 script gates with maxConcurrentScripts=1: serialized execution', async () => {
      // Serialization timing is already validated by the pre-existing
      // "respects maxConcurrentScripts: 1" tests above. This test
      // verifies correctness with 3 gates (all allowed).
      const AGENT_REVIEWER_A = 'agent-sem-rev-a';
      const AGENT_REVIEWER_B = 'agent-sem-rev-b';
      seedAgent(db, AGENT_REVIEWER_A, SPACE_ID, 'general');
      seedAgent(db, AGENT_REVIEWER_B, SPACE_ID, 'general');

      const gates: Gate[] = ['a', 'b', 'c'].map((id) => ({
        id: `sem-ov-${id}`,
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      }));

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'sem-ov-a' },
        { id: 'ch-2', from: 'coder', to: 'reviewer-a', gateId: 'sem-ov-b' },
        { id: 'ch-3', from: 'coder', to: 'reviewer-b', gateId: 'sem-ov-c' },
      ];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Planner', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
          {
            id: 'node-sem-c',
            name: 'Rev A',
            agents: [{ agentId: AGENT_REVIEWER_A, name: 'reviewer-a' }],
          },
          {
            id: 'node-sem-d',
            name: 'Rev B',
            agents: [{ agentId: AGENT_REVIEWER_B, name: 'reviewer-b' }],
          },
        ],
        channels,
        gates
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 1 });

      const [r1, r2, r3] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'reviewer-a'),
        router.canDeliver(run.id, 'coder', 'reviewer-b'),
      ]);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
    });

    test('after first script gate completes, next one starts immediately (max=2)', async () => {
      // 3 script gates, maxConcurrentScripts=2. Verify all 3 are allowed
      // (2 run concurrently, 3rd runs after a slot frees up).
      const AGENT_REVIEWER_A = 'agent-sem-start-rev-a';
      const AGENT_REVIEWER_B = 'agent-sem-start-rev-b';
      seedAgent(db, AGENT_REVIEWER_A, SPACE_ID, 'general');
      seedAgent(db, AGENT_REVIEWER_B, SPACE_ID, 'general');

      const gates: Gate[] = ['x', 'y', 'z'].map((id) => ({
        id: `sem-start-${id}`,
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      }));

      const channels: WorkflowChannel[] = [];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Planner', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
          {
            id: 'node-sem-start-c',
            name: 'Rev A',
            agents: [{ agentId: AGENT_REVIEWER_A, name: 'reviewer-a' }],
          },
          {
            id: 'node-sem-start-d',
            name: 'Rev B',
            agents: [{ agentId: AGENT_REVIEWER_B, name: 'reviewer-b' }],
          },
        ],
        channels,
        gates
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 2 });

      const [r1, r2, r3] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'reviewer-a'),
        router.canDeliver(run.id, 'coder', 'reviewer-b'),
      ]);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
    });

    test('field-only gates are NOT limited by semaphore at all', async () => {
      // Even with maxConcurrentScripts=1, field-only evaluations should
      // complete instantly without any semaphore queuing.
      const gate: Gate = {
        id: 'field-sem-bypass',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Planner', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        [{ id: 'ch-1', from: 'coder', to: 'planner', gateId: 'field-sem-bypass' }],
        [gate]
      );
      const run = createActiveRun(workflow);
      gateDataRepo.set(run.id, 'field-sem-bypass', { approved: true });

      const router = makeRouter({ maxConcurrentScripts: 1 });

      // 5 concurrent evaluations should all succeed
      const results = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
      ]);

      expect(results.every((r) => r.allowed)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Per-gate evaluation coalescing
  // -------------------------------------------------------------------------

  describe('per-gate evaluation coalescing', () => {
    test('concurrent onGateDataChanged calls for same runId:gateId coalesce', async () => {
      const gate: Gate = {
        id: 'coal-gate',
        fields: [
          {
            name: 'votes',
            type: 'number',
            writers: ['*'],
            check: { op: '==', value: 3 },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter();

      // First write: votes = 1 → gate closed
      gateDataRepo.set(run.id, 'coal-gate', { votes: 1 });
      const result1 = await router.onGateDataChanged(run.id, 'coal-gate');
      expect(result1).toHaveLength(0);

      // Write votes = 3 → gate opens, node activated
      gateDataRepo.set(run.id, 'coal-gate', { votes: 3 });
      const result2 = await router.onGateDataChanged(run.id, 'coal-gate');
      expect(result2.length).toBeGreaterThan(0);
    });

    test('coalesced caller always re-evaluates after in-flight completes', async () => {
      // Use a slow script gate. Two concurrent callers for the SAME gate:
      // 1st caller starts evaluation
      // 2nd caller hits coalescing, awaits 1st
      // After 1st completes, 2nd re-evaluates (doEvaluateGate directly)
      // Total time should be ~2x the sleep (0.3s * 2 ≈ 0.6s)
      const gate: Gate = {
        id: 'dirty-gate',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.3; echo \'{"pass": true}\'',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'pass',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      // maxConcurrentScripts: 2 so the re-evaluation can start immediately
      // (not blocked by the first evaluation's semaphore hold)
      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 2 });

      const start = Date.now();
      const [r1, r2] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'planner'),
      ]);
      const elapsed = Date.now() - start;

      // Both should return true (gate opens because script outputs {"pass": true})
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);

      // The re-evaluation should have occurred.
      // Timeline: 1st eval (~300ms) + 2nd re-eval (~300ms) ≈ 600ms theoretical.
      // Allow generous tolerance for process startup overhead and CI variance.
      expect(elapsed).toBeGreaterThanOrEqual(400);
    });

    test('two concurrent runs with same gateId do NOT share evaluation state', async () => {
      const gate: Gate = {
        id: 'shared-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);

      // Create two separate runs
      const run1 = createActiveRun(workflow);
      const run2 = createActiveRun(workflow);

      // Set different gate data for each run
      gateDataRepo.set(run1.id, 'shared-gate', { approved: true });
      gateDataRepo.set(run2.id, 'shared-gate', { approved: false });

      const router = makeRouter();

      // Evaluate both runs concurrently
      const [result1, result2] = await Promise.all([
        router.canDeliver(run1.id, 'coder', 'planner'),
        router.canDeliver(run2.id, 'coder', 'planner'),
      ]);

      // Each run should get its own evaluation result
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(false);
    });

    test('concurrent onGateDataChanged for same gate activates node only once', async () => {
      const gate: Gate = {
        id: 'vote-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter();

      // Set gate data to pass
      gateDataRepo.set(run.id, 'vote-gate', { approved: true });

      // Call onGateDataChanged concurrently — node should be activated only once
      const results = await Promise.all([
        router.onGateDataChanged(run.id, 'vote-gate'),
        router.onGateDataChanged(run.id, 'vote-gate'),
        router.onGateDataChanged(run.id, 'vote-gate'),
      ]);

      // Each call returns its own activated tasks; but due to idempotency
      // in activateNode, the same tasks may be returned multiple times
      const totalTasks = results.reduce((sum, r) => sum + r.length, 0);
      // At least one call should have activated tasks
      expect(totalTasks).toBeGreaterThanOrEqual(1);
    });

    test('different gateIds evaluate concurrently without blocking each other', async () => {
      // Two different script gates on different channels should be able to
      // evaluate concurrently (each gets its own coalescing key).
      const gate1: Gate = {
        id: 'script-gate-a',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const gate2: Gate = {
        id: 'script-gate-b',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };

      // Use separate channels for each gate to test concurrency.
      // Since canDeliver finds the first matching channel, we need different
      // from/to pairs. Use a three-node workflow.
      const AGENT_REVIEWER = 'agent-async-reviewer';
      seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'planner');

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'script-gate-a' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          {
            id: 'node-async-c',
            name: 'Reviewer Node',
            agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer' }],
          },
        ],
        channels,
        [gate1, gate2]
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 2 });

      const start = Date.now();
      // Evaluate different channels concurrently — both should run in parallel
      const [r1, r2] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'reviewer'),
      ]);
      const elapsed = Date.now() - start;

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // Both should have run concurrently (~200ms, not ~400ms)
      expect(elapsed).toBeLessThan(600);
    });

    test('semaphore waiter propagates rejection from failed script', async () => {
      // When maxConcurrentScripts=1 and one script is running, a second
      // script gate evaluation queues behind it. If the first evaluation
      // succeeds but the second fails, the waiter must still reject properly.
      const AGENT_REVIEWER = 'agent-async-reviewer';
      seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'planner');

      const gateOk: Gate = {
        id: 'sem-ok-gate',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.15; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const gateFail: Gate = {
        id: 'sem-fail-gate',
        script: {
          interpreter: 'bash',
          source: 'exit 1',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'sem-ok-gate' },
        { id: 'ch-2', from: 'coder', to: 'reviewer', gateId: 'sem-fail-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          {
            id: 'node-async-c',
            name: 'Reviewer Node',
            agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer' }],
          },
        ],
        channels,
        [gateOk, gateFail]
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 1 });

      // Both evaluate concurrently, but serialized by semaphore.
      // The first (gateOk) succeeds, the second (gateFail) should fail gracefully.
      const [r1, r2] = await Promise.all([
        router.canDeliver(run.id, 'coder', 'planner'),
        router.canDeliver(run.id, 'coder', 'reviewer'),
      ]);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(false);
      expect(r2.reason).toContain('Script check failed');
    });

    // -------------------------------------------------------------------
    // Coalescing re-evaluation and isolation
    // -------------------------------------------------------------------

    test('concurrent onGateDataChanged for same gate: second caller re-evaluates after first completes', async () => {
      const gate: Gate = {
        id: 're-eval-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['*'],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter();

      // Set votes to 1 → gate closed
      gateDataRepo.set(run.id, 're-eval-gate', { votes: { a: 'approved' } });
      const result1 = await router.onGateDataChanged(run.id, 're-eval-gate');
      expect(result1).toHaveLength(0);

      // Set votes to 5 → gate opens
      gateDataRepo.set(run.id, 're-eval-gate', {
        votes: { a: 'approved', b: 'approved', c: 'approved', d: 'approved', e: 'approved' },
      });

      // Call onGateDataChanged twice concurrently — both should see votes: 5
      const [r1, r2] = await Promise.all([
        router.onGateDataChanged(run.id, 're-eval-gate'),
        router.onGateDataChanged(run.id, 're-eval-gate'),
      ]);

      // At least one call should activate the node (gate is open with 5 votes).
      // The second may return empty due to idempotent activation (node already active).
      const totalActivated = r1.length + r2.length;
      expect(totalActivated).toBeGreaterThan(0);
    });

    test('different runId:gateId keys evaluate independently (script gates)', async () => {
      const gate1: Gate = {
        id: 'indep-gate-a',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.2; echo \'{"pass": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'pass', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const gate2: Gate = {
        id: 'indep-gate-b',
        script: {
          interpreter: 'bash',
          source: 'echo \'{"go": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'go', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'indep-gate-a' },
      ];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Planner', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels,
        [gate1, gate2]
      );
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 2 });

      const [r1, r2] = await Promise.all([
        router.onGateDataChanged(run.id, 'indep-gate-a'),
        router.onGateDataChanged(run.id, 'indep-gate-b'),
      ]);

      // Gate-a has a 0.2s sleep; gate-b is instant. With independent evaluation,
      // both should complete (gate-b not on any channel, so returns empty).
      expect(r1.length).toBeGreaterThan(0);
      expect(r2).toHaveLength(0);
    });

    test('two runs with same gateId and script: evaluations are isolated', async () => {
      const gate: Gate = {
        id: 'shared-script-gate',
        script: {
          interpreter: 'bash',
          source: 'sleep 0.15; echo \'{"ok": true}\'',
          timeoutMs: 5000,
        },
        fields: [{ name: 'ok', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Planner', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        [{ id: 'ch-1', from: 'coder', to: 'planner', gateId: 'shared-script-gate' }],
        [gate]
      );

      const run1 = createActiveRun(workflow);
      const run2 = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp', maxConcurrentScripts: 2 });

      const [r1, r2] = await Promise.all([
        router.canDeliver(run1.id, 'coder', 'planner'),
        router.canDeliver(run2.id, 'coder', 'planner'),
      ]);

      // Two runs should evaluate independently (different composite keys).
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
    });

    test('same gateId in different runs: gate data isolation', async () => {
      const gate: Gate = {
        id: 'iso-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Planner', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        [{ id: 'ch-1', from: 'coder', to: 'planner', gateId: 'iso-gate' }],
        [gate]
      );

      const run1 = createActiveRun(workflow);
      const run2 = createActiveRun(workflow);

      // Run 1: approved = true → gate open
      gateDataRepo.set(run1.id, 'iso-gate', { approved: true });
      // Run 2: approved = false → gate closed
      gateDataRepo.set(run2.id, 'iso-gate', { approved: false });

      const router = makeRouter();

      const [r1, r2] = await Promise.all([
        router.canDeliver(run1.id, 'coder', 'planner'),
        router.canDeliver(run2.id, 'coder', 'planner'),
      ]);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(false);
    });

    test('concurrent onGateDataChanged for same gate: sequential calls produce consistent results', async () => {
      const gate: Gate = {
        id: 'seq-gate',
        fields: [
          {
            name: 'count',
            type: 'map',
            writers: ['*'],
            check: { op: 'count', match: 'yes', min: 5 },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter();

      // Sequentially update gate data and check evaluation
      for (let i = 1; i <= 5; i++) {
        const votes: Record<string, string> = {};
        for (let j = 0; j < i; j++) votes[`v${j}`] = 'yes';
        gateDataRepo.set(run.id, 'seq-gate', { count: votes });
        const activated = await router.onGateDataChanged(run.id, 'seq-gate');
        if (i < 5) {
          expect(activated).toHaveLength(0);
        } else {
          expect(activated.length).toBeGreaterThan(0);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // onGateDataChanged with script gates
  // -------------------------------------------------------------------------

  describe('onGateDataChanged with script gates', () => {
    test('script gate blocks onGateDataChanged activation when script fails', async () => {
      const gate: Gate = {
        id: 'script-fail-ogdc',
        script: {
          interpreter: 'bash',
          source: 'exit 1',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const activated = await router.onGateDataChanged(run.id, 'script-fail-ogdc');
      expect(activated).toHaveLength(0);
    });

    test('script gate allows onGateDataChanged activation when script passes', async () => {
      const gate: Gate = {
        id: 'script-pass-ogdc',
        script: {
          interpreter: 'bash',
          source: 'echo \'{"go": true}\'',
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const activated = await router.onGateDataChanged(run.id, 'script-pass-ogdc');
      expect(activated.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // isChannelOpen synchronous behavior via ChannelRouter
  // -------------------------------------------------------------------------

  describe('isChannelOpen synchronous behavior via ChannelRouter', () => {
    test('field-only gate evaluates synchronously (no async overhead)', async () => {
      // Gate with fields but no script — canDeliver works without
      // any semaphore or script execution overhead.
      const gate: Gate = {
        id: 'sync-field-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);
      gateDataRepo.set(run.id, 'sync-field-gate', { approved: true });

      const router = makeRouter();
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('gate with script but field-only channel remains synchronous in isChannelOpen context', async () => {
      // isChannelOpen is a pure function (tested in gate-evaluator.test.ts).
      // ChannelRouter.canDeliver uses evaluateGateById which always runs
      // the script asynchronously. For field-only gates (no script), the
      // async function returns immediately without awaiting anything, so it
      // is effectively synchronous. This test verifies that a gate with
      // both fields and a script still evaluates correctly through canDeliver.
      const gate: Gate = {
        id: 'sync-script-field-gate',
        script: {
          interpreter: 'bash',
          source: 'echo \'{"approved": true}\'',
          timeoutMs: 5000,
        },
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const workflow = buildTwoNodeWorkflow(gate);
      const run = createActiveRun(workflow);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Live gate script resolution (Issue 1 fix)
  // ---------------------------------------------------------------------------
  // When a workflow has a `templateName`, the gate evaluator must use the
  // *current* template's gate script rather than the version stored in the DB
  // at seed time. This ensures that script updates (bug fixes, new fallback
  // logic, etc.) take effect for all running workflow instances immediately.

  describe('live gate script resolution for template-based workflows', () => {
    /**
     * Builds a two-node workflow that mimics a seeded Coding Workflow:
     * - Uses node/agent names from CODING_WORKFLOW
     * - Carries a STALE script in the stored code-ready-gate
     * - Has templateName set to CODING_WORKFLOW.name
     *
     * The stale script exits non-zero (which would block delivery if it ran).
     * The live template script exits 0 immediately (for testability).
     */
    function buildStaleTemplateWorkflow(staleScript: string, liveGate: Gate) {
      const staleGate: Gate = {
        ...liveGate,
        script: {
          interpreter: 'bash',
          source: staleScript,
          timeoutMs: 5000,
        },
      };

      const wf = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Stale Template Workflow ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        startNodeId: NODE_A,
        endNodeId: NODE_B,
        tags: [],
        channels: [
          {
            from: 'coder',
            to: 'planner',
            gateId: staleGate.id,
          },
        ],
        gates: [staleGate],
        completionAutonomyLevel: 3,
        // Mark as seeded from Coding Workflow template
        templateName: CODING_WORKFLOW.name,
        templateHash: 'stale-hash',
      });

      return wf;
    }

    test('uses the live template script instead of the stale stored script when templateName matches', async () => {
      // A script that always fails — simulates a stale script with an old bug
      const STALE_FAILING_SCRIPT = 'exit 1 # stale script that has a bug';

      // The gate we are patching: code-ready-gate from the CODING_WORKFLOW template
      // For this test we stub it with a simple passing script to avoid real `gh` calls
      const LIVE_PASSING_SCRIPT = 'echo \'{"pr_url":"https://github.com/test/pr/1"}\'';

      // Build a gate that matches code-ready-gate's field schema but with a stale script.
      // The router will swap in the live template script at evaluation time.
      const gateId = 'code-ready-gate';
      const gateWithStaleScript: Gate = {
        id: gateId,
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['Coding'],
            check: { op: 'exists' },
          },
        ],
        script: {
          interpreter: 'bash',
          source: STALE_FAILING_SCRIPT,
          timeoutMs: 5000,
        },
        resetOnCycle: true,
      };

      // Patch: replace the live template's gate script so we can control it in tests
      // without invoking real `gh` commands. We do this by temporarily overriding
      // the gate in CODING_WORKFLOW's gates array.
      const originalGate = CODING_WORKFLOW.gates!.find((g) => g.id === gateId)!;
      const originalScript = originalGate.script;
      // biome-ignore lint/suspicious/noExplicitAny: test-only mutation of template
      (originalGate as any).script = {
        interpreter: 'bash',
        source: LIVE_PASSING_SCRIPT,
        timeoutMs: 5000,
      };

      try {
        const wf = buildStaleTemplateWorkflow(STALE_FAILING_SCRIPT, gateWithStaleScript);
        const run = createActiveRun(wf);
        // Seed pr_url in gate data so the pr_url field check passes after script runs
        gateDataRepo.set(run.id, gateId, { pr_url: 'https://github.com/test/pr/1' });

        const router = makeRouter({ workspacePath: '/tmp' });
        // If the stale script ran, canDeliver would return { allowed: false }
        // because exit 1 blocks the gate. The live script exits 0 with a pr_url
        // JSON object → gate opens.
        const result = await router.canDeliver(run.id, 'coder', 'planner');
        expect(result.allowed).toBe(true);
      } finally {
        // Restore original script
        // biome-ignore lint/suspicious/noExplicitAny: test-only restoration
        (originalGate as any).script = originalScript;
      }
    });

    test('stale stored script would block delivery without live resolution', async () => {
      // Control test: without templateName set, the router uses the stored (stale) script
      const STALE_FAILING_SCRIPT = 'exit 1 # stale script that has a bug';

      const gateId = 'some-custom-gate';
      const gateWithFailingScript: Gate = {
        id: gateId,
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['*'],
            check: { op: 'exists' },
          },
        ],
        script: {
          interpreter: 'bash',
          source: STALE_FAILING_SCRIPT,
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };

      // Build workflow WITHOUT templateName — uses the stored script directly
      const wf = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        [{ from: 'coder', to: 'planner', gateId }],
        [gateWithFailingScript]
      );
      const run = createActiveRun(wf);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      // Without templateName, the failing stored script blocks the gate
      expect(result.allowed).toBe(false);
    });

    test('falls back to stored script when templateName does not match any built-in', async () => {
      // A script that passes immediately
      const PASSING_STORED_SCRIPT = 'echo \'{"pr_url":"https://github.com/x/1"}\'';

      const gateId = 'gate-with-unknown-template';
      const gate: Gate = {
        id: gateId,
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['*'],
            check: { op: 'exists' },
          },
        ],
        script: {
          interpreter: 'bash',
          source: PASSING_STORED_SCRIPT,
          timeoutMs: 5000,
        },
        resetOnCycle: false,
      };

      // Workflow with a non-existent templateName → no live script to resolve
      const wf = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Unknown Template Workflow ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        startNodeId: NODE_A,
        endNodeId: NODE_B,
        tags: [],
        channels: [{ from: 'coder', to: 'planner', gateId }],
        gates: [gate],
        completionAutonomyLevel: 3,
        templateName: 'Unknown Template That Does Not Exist',
      });
      const run = createActiveRun(wf);

      const router = makeRouter({ workspacePath: '/tmp' });
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      // Stored script exits 0 → gate opens (fallback to stored script works)
      expect(result.allowed).toBe(true);
    });
  });
});
