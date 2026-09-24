import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { invokeOperationFromHandler } from '../../../../src/lib/operations/handler-invoker';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import {
  type ArtifactOperationDependencies,
  createArtifactOperations,
} from '../../../../src/lib/artifacts/artifact-operations';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let nodeExecutions: NodeExecutionRepository;
let artifactRepo: WorkflowRunArtifactRepository;
let auditLogRepo: McpAuditLogRepository;
let operations: Map<string, OperationDefinition>;
let bareOperations: Map<string, OperationDefinition>;
let SPACE: string;
let RUN: string;
let TASK: string;

function workerSession(
  id: string,
  options: { nodeId?: string; withExecution?: boolean; agentSessionId?: string | null } = {}
) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status: 'active',
      context: { spaceId: SPACE, taskId: TASK },
    },
    { enforceWorkspaceOwnership: false }
  );
  if (options.withExecution !== false) {
    nodeExecutions.create({
      workflowRunId: RUN,
      workflowNodeId: options.nodeId ?? 'node-a',
      agentName: 'coder',
      agentSessionId: options.agentSessionId === undefined ? id : options.agentSessionId,
    });
  }
  return id;
}

function worker(sessionId: string): OperationCaller {
  return { source: 'mcp', sessionId, spaceId: SPACE, role: 'workflow_worker', agentName: 'coder' };
}

function run(
  registry: Map<string, OperationDefinition>,
  name: string,
  input: unknown,
  caller: OperationCaller
) {
  const operation = registry.get(name);
  if (!operation) throw new Error(`operation ${name} not registered`);
  return operation.execute(input, caller);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  SPACE = new SpaceRepository(db).createSpace({
    name: 'Artifacts',
    slug: 'artifacts',
    workspacePath: '/repo',
  }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId: SPACE, name: 'W' });
  RUN = new SpaceWorkflowRunRepository(db).createRun({
    spaceId: SPACE,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  TASK = new SpaceTaskRepository(db).createTask({ spaceId: SPACE, title: 'T', description: '' }).id;
  sessions = new SessionRepository(db);
  nodeExecutions = new NodeExecutionRepository(db);
  artifactRepo = new WorkflowRunArtifactRepository(db);
  auditLogRepo = new McpAuditLogRepository(db);
  const deps: ArtifactOperationDependencies = {
    nodeExecutionRepo: nodeExecutions,
    artifactRepo,
    auditLogRepo,
    getSession: (id) => sessions.getSession(id),
  };
  operations = new Map(
    createArtifactOperations(deps).map((operation) => [operation.name, operation])
  );
  bareOperations = new Map(
    createArtifactOperations({
      nodeExecutionRepo: nodeExecutions,
      artifactRepo,
      getSession: (id) => sessions.getSession(id),
    }).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

describe('artifact operations', () => {
  test('saves an artifact with the run and node resolved from the calling session', async () => {
    const sessionId = workerSession('s-save');
    const result = (await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'note', summary: 'shipping' },
      worker(sessionId)
    )) as {
      success: boolean;
      artifact: { runId: string; nodeId: string; shape: string; key: string };
    };
    expect(result.success).toBe(true);
    expect(result.artifact).toMatchObject({
      runId: RUN,
      nodeId: 'node-a',
      shape: 'note',
      key: 'current',
    });
    const stored = artifactRepo.listByRun(RUN, { nodeId: 'node-a', artifactType: 'note' });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data).toEqual({ summary: 'shipping' });
  });

  test('records an audit entry carrying the resolved slot', async () => {
    const sessionId = workerSession('s-audit');
    await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'note', summary: 'audited' },
      worker(sessionId)
    );
    const entries = auditLogRepo.listBySession(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!).toMatchObject({
      toolName: 'save_artifact',
      agentName: 'coder',
      spaceId: SPACE,
      taskId: TASK,
      workflowRunId: RUN,
    });
    expect(JSON.parse(entries[0]!.paramsSummary!)).toMatchObject({
      shape: 'note',
      key: 'current',
    });
  });

  test('reports an invalid payload as a result value and persists nothing', async () => {
    const sessionId = workerSession('s-invalid');
    const empty = (await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'note' },
      worker(sessionId)
    )) as {
      success: boolean;
      error: string;
    };
    expect(empty).toEqual({
      success: false,
      error: 'At least one of `summary` or `data` must be provided.',
    });
    const badLink = (await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'link', data: { url: 'not-a-url' } },
      worker(sessionId)
    )) as { success: boolean; error: string };
    expect(badLink.success).toBe(false);
    expect(badLink.error).toContain('link');
    expect(artifactRepo.listByRun(RUN)).toEqual([]);
    expect(auditLogRepo.listBySession(sessionId)).toEqual([]);
  });

  test('lists run artifacts narrowed by nodeId and shape', async () => {
    const nodeA = workerSession('s-a');
    const nodeB = workerSession('s-b', { nodeId: 'node-b' });
    await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'note', summary: 'a note' },
      worker(nodeA)
    );
    await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'link', kind: 'pr', data: { url: 'https://github.com/acme/widgets/pull/7' } },
      worker(nodeA)
    );
    await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'note', summary: 'b note' },
      worker(nodeB)
    );

    const all = (await run(operations, 'workflow.run.artifact.list', {}, worker(nodeA))) as {
      success: boolean;
      artifacts: Array<{
        nodeId: string;
        type: string;
        key: string;
        data: Record<string, unknown>;
      }>;
    };
    expect(all.success).toBe(true);
    expect(all.artifacts).toHaveLength(3);

    const nodeScoped = (await run(
      operations,
      'workflow.run.artifact.list',
      { nodeId: 'node-a' },
      worker(nodeA)
    )) as {
      artifacts: Array<{ nodeId: string }>;
    };
    expect(nodeScoped.artifacts.map((artifact) => artifact.nodeId)).toEqual(['node-a', 'node-a']);

    const links = (await run(
      operations,
      'workflow.run.artifact.list',
      { type: 'link' },
      worker(nodeA)
    )) as {
      artifacts: Array<{ type: string; key: string; data: Record<string, unknown> }>;
    };
    expect(links.artifacts).toHaveLength(1);
    expect(links.artifacts[0]!.key).toBe('pr');
    expect(links.artifacts[0]!.data.url).toBe('https://github.com/acme/widgets/pull/7');
  });

  test('denies a caller that is not a workflow worker', async () => {
    const sessionId = workerSession('s-member', { withExecution: false });
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId,
      spaceId: SPACE,
      role: 'long_term_agent',
    };
    expect(
      await run(operations, 'workflow.run.artifact.save', { shape: 'note', summary: 'x' }, caller)
    ).toEqual({ accepted: false, reason: 'node_caller_denied' });
    expect(await run(operations, 'workflow.run.artifact.list', {}, caller)).toEqual({
      accepted: false,
      reason: 'node_caller_denied',
    });
    expect(artifactRepo.listByRun(RUN)).toEqual([]);
  });

  test('rejects not_a_node_agent without a session or node execution', async () => {
    const caller = worker(workerSession('s-orphan', { withExecution: false }));
    expect(
      await run(operations, 'workflow.run.artifact.save', { shape: 'note', summary: 'x' }, caller)
    ).toEqual({ accepted: false, reason: 'not_a_node_agent' });
    expect(await run(operations, 'workflow.run.artifact.list', {}, caller)).toEqual({
      accepted: false,
      reason: 'not_a_node_agent',
    });

    const missingSession = worker('s-never-created');
    expect(await run(operations, 'workflow.run.artifact.list', {}, missingSession)).toEqual({
      accepted: false,
      reason: 'not_a_node_agent',
    });

    const sessionless: OperationCaller = {
      source: 'mcp',
      spaceId: SPACE,
      role: 'workflow_worker',
    };
    expect(await run(operations, 'workflow.run.artifact.list', {}, sessionless)).toEqual({
      accepted: false,
      reason: 'not_a_node_agent',
    });
  });

  test('resolves the slot from an exec sub-session id', async () => {
    const execution = nodeExecutions.create({
      workflowRunId: RUN,
      workflowNodeId: 'node-c',
      agentName: 'coder',
      agentSessionId: null,
    });
    const sessionId = `task-1:exec:${execution.id}`;
    sessions.createSession(
      {
        ...createTestSession(sessionId),
        workspacePath: '/repo',
        type: 'worker',
        status: 'active',
        context: { spaceId: SPACE, taskId: TASK },
      },
      { enforceWorkspaceOwnership: false }
    );
    const result = (await run(
      operations,
      'workflow.run.artifact.save',
      { shape: 'note', summary: 'via fallback' },
      worker(sessionId)
    )) as { success: boolean; artifact: { nodeId: string } };
    expect(result.success).toBe(true);
    expect(result.artifact.nodeId).toBe('node-c');
  });

  test('saves without an audit repository', async () => {
    const sessionId = workerSession('s-bare');
    const result = (await run(
      bareOperations,
      'workflow.run.artifact.save',
      { shape: 'note', summary: 'bare' },
      worker(sessionId)
    )) as { success: boolean };
    expect(result.success).toBe(true);
    expect(artifactRepo.listByRun(RUN, { nodeId: 'node-a' })).toHaveLength(1);
  });
});

test.each(['workflow.run.artifact.save', 'workflow.run.artifact.list'])(
  '%s exposes a recognized rejection through the operation door',
  async (name) => {
    const input = name === 'workflow.run.artifact.save' ? { shape: 'note', summary: 'x' } : {};
    const outcome = await invokeOperation(operations, name, input, { source: 'rpc' });
    expect(outcome).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'not_a_node_agent' },
    });
    const mcp = createOperationMcpHandler(operations, () => ({ role: 'workflow_worker' }));
    const response = await mcp({ name, input });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text)).toEqual(
      outcome.kind === 'completed' ? outcome.value : null
    );
    await expect(invokeOperationFromHandler(operations, name, input)).rejects.toThrow(
      `Operation ${name} was rejected without a message`
    );
  }
);
