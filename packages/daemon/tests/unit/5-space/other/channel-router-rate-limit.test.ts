/**
 * ChannelRouter rate-limit deferral tests.
 *
 * Verifies that a bash gate script emitting a GitHub rate-limit signature
 * surfaces `rateLimited: true` + `retryAfterMs` all the way through:
 *   - GateScriptResult (executor)
 *   - GateEvalResult (evaluator)
 *   - GateResult / ChannelGateBlockedError (router canDeliver / deliverMessage)
 *
 * This is the missing "wired consumer" required by the rate-limit-aware
 * gate hook layer: without it, the agent would see only `allowed: false`
 * and re-dispatch on the next tick, burning more API calls.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import {
  ChannelRouter,
  ChannelGateBlockedError,
} from '../../../../src/lib/space/runtime/channel-router.ts';
import type { Gate, WorkflowChannel } from '@neokai/shared';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../../src/lib/space/runtime/rate-limit-detector.ts';

function makeDb(): BunDatabase {
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

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

const SPACE_ID = 'space-rl-1';
const AGENT_CODER = 'agent-rl-coder';
const AGENT_PLANNER = 'agent-rl-planner';
const NODE_A = 'node-rl-a';
const NODE_B = 'node-rl-b';

const RATE_LIMIT_STDERR =
  'echo "HTTP 403: rate limit exceeded (https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting)" >&2; exit 1';

function rateLimitScriptGate(): Gate {
  return {
    id: 'rate-limit-gate',
    script: {
      interpreter: 'bash',
      source: RATE_LIMIT_STDERR,
      timeoutMs: 5000,
    },
    resetOnCycle: false,
  };
}

describe('ChannelRouter rate-limit deferral', () => {
  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowManager: SpaceWorkflowManager;
  let agentManager: SpaceAgentManager;
  let gateDataRepo: GateDataRepository;
  let channelCycleRepo: ChannelCycleRepository;

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID);
    seedAgent(db, AGENT_CODER, SPACE_ID, 'coder');
    seedAgent(db, AGENT_PLANNER, SPACE_ID, 'planner');

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    gateDataRepo = new GateDataRepository(db);
    channelCycleRepo = new ChannelCycleRepository(db);
    agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  });

  afterEach(() => {
    db.close();
  });

  function makeRouter(): ChannelRouter {
    return new ChannelRouter({
      taskRepo,
      workflowRunRepo,
      workflowManager,
      agentManager,
      gateDataRepo,
      channelCycleRepo,
      db,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      workspacePath: '/tmp',
    });
  }

  function buildWorkflow(gate: Gate) {
    const channels: WorkflowChannel[] = [{ from: 'coder', to: 'planner', gateId: gate.id }];
    return workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `RL Test Workflow ${Date.now()}`,
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
      transitions: [],
      startNodeId: NODE_A,
      rules: [],
      tags: [],
      channels,
      gates: [gate],
      completionAutonomyLevel: 3,
    });
  }

  function createActiveRun(workflowId: string) {
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId,
      title: 'RL Test Run',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'RL Test Run Task',
      description: '',
      status: 'open',
      workflowRunId: run.id,
    });
    return run;
  }

  test('canDeliver surfaces rateLimited + retryAfterMs on rate-limited script gate', async () => {
    const workflow = buildWorkflow(rateLimitScriptGate());
    const run = createActiveRun(workflow.id);
    const router = makeRouter();

    const result = await router.canDeliver(run.id, 'coder', 'planner');
    expect(result.allowed).toBe(false);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    expect(result.reason).toContain('rate limit');
  });

  test('deliverMessage throws ChannelGateBlockedError with rateLimited flag', async () => {
    const workflow = buildWorkflow(rateLimitScriptGate());
    const run = createActiveRun(workflow.id);
    const router = makeRouter();

    let caught: ChannelGateBlockedError | null = null;
    try {
      await router.deliverMessage(run.id, 'coder', 'planner', 'hi');
    } catch (err) {
      if (err instanceof ChannelGateBlockedError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.rateLimited).toBe(true);
    expect(caught!.retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    expect(caught!.gateIdentifier).toBe('rate-limit-gate');
    expect(caught!.message).toContain('rate limit');
  });

  test('non-rate-limit script failure keeps rateLimited false', async () => {
    const gate: Gate = {
      id: 'plain-fail-gate',
      script: {
        interpreter: 'bash',
        source: 'echo "HTTP 404: Not Found" >&2; exit 1',
        timeoutMs: 5000,
      },
      resetOnCycle: false,
    };
    const workflow = buildWorkflow(gate);
    const run = createActiveRun(workflow.id);
    const router = makeRouter();

    const result = await router.canDeliver(run.id, 'coder', 'planner');
    expect(result.allowed).toBe(false);
    expect(result.rateLimited).toBe(false);
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.reason).toContain('Not Found');
  });
});
