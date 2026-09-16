import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createNodeAgentRestoreOperation } from '../../../../src/lib/external-events/node-agent-restore-operation';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let operation: OperationDefinition;
let restores: Array<{ sessionId: string; reason?: string }>;
let restoreResult: boolean;
let SPACE: string;

function workerSession(id: string, status: 'active' | 'archived' = 'active') {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status,
      context: { spaceId: SPACE },
    },
    { enforceWorkspaceOwnership: false }
  );
  return id;
}

function worker(sessionId: string): OperationCaller {
  return { source: 'mcp', sessionId, spaceId: SPACE, role: 'workflow_worker', agentName: 'coder' };
}

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  SPACE = new SpaceRepository(db).createSpace({
    name: 'Heal',
    slug: 'heal',
    workspacePath: '/repo',
  }).id;
  sessions = new SessionRepository(db);
  restores = [];
  restoreResult = true;
  operation = createNodeAgentRestoreOperation({
    restoreNodeAgent: async (sessionId, reason) => {
      restores.push({ sessionId, reason });
      return restoreResult;
    },
    getSession: (id) => sessions.getSession(id),
    taskRepo: new SpaceTaskRepository(db),
    nodeExecutionRepo: new NodeExecutionRepository(db),
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
  });
});

afterEach(() => db.close());

describe('node agent restore operation', () => {
  test('re-attaches the calling session and trims the reason', async () => {
    const sessionId = workerSession('s-heal');
    const result = await operation.execute({ reason: '  no such tool  ' }, worker(sessionId));
    expect(result).toMatchObject({ reattached: true, sessionId });
    expect(restores).toEqual([{ sessionId, reason: 'no such tool' }]);
  });

  test('reports reattached: false without blaming a missing session for a failed re-attach', async () => {
    restoreResult = false;
    const sessionId = workerSession('s-gone');
    const result = (await operation.execute({}, worker(sessionId))) as {
      reattached: boolean;
      message: string;
    };
    expect(result.reattached).toBe(false);
    expect(result.message).toContain('not re-attached');
    expect(result.message).toContain('the re-attach itself failed');
  });

  test('denies a space member that is not a workflow worker', async () => {
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: workerSession('s-member'),
      spaceId: SPACE,
      role: 'ad_hoc_member',
    };
    expect(await operation.execute({}, caller)).toBe('caller_denied');
    expect(restores).toEqual([]);
  });

  test('refuses an archived session in the owning space and re-attaches nothing', async () => {
    const sessionId = workerSession('s-archived', 'archived');
    expect(await operation.execute({}, worker(sessionId))).toBe('session_inactive');
    expect(restores).toEqual([]);
  });

  test('denies an RPC caller, which owns no node-agent session', async () => {
    expect(await operation.execute({}, { source: 'rpc' })).toBe('caller_denied');
    expect(restores).toEqual([]);
  });
});
