import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('ToolContinuationRecoveryRepository', () => {
  let db: Database;
  let tempDir: string | null = null;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
  });

  afterEach(() => {
    db.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function seedExecution(sessionId = 'agent-session-1') {
    const space = new SpaceRepository(db as any).createSpace({
      workspacePath: `/tmp/ws-${Math.random()}`,
      slug: `space-${Math.random().toString(36).slice(2)}`,
      name: 'Space',
    });
    const now = Date.now();
    const workflowId = `workflow-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
			 VALUES (?, ?, 'Workflow', ?, ?)`
    ).run(workflowId, space.id, now, now);
    const run = new SpaceWorkflowRunRepository(db as any).createRun({
      spaceId: space.id,
      workflowId,
      title: 'Run',
    });
    const repo = new NodeExecutionRepository(db as any);
    const execution = repo.create({
      workflowRunId: run.id,
      workflowNodeId: 'node-1',
      agentName: 'coder',
      status: 'in_progress',
      agentSessionId: sessionId,
    });
    return { execution, run };
  }

  it('persists tool_use ownership and queued continuation across database reopen', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'neokai-tool-continuation-'));
    const dbPath = join(tempDir, 'test.sqlite');
    db.close();

    db = new Database(dbPath);
    createSpaceTables(db);
    const { execution, run } = seedExecution('session-a');
    let repo = new ToolContinuationRecoveryRepository(db as any);
    repo.ensureSchema();
    repo.recordToolUse({ toolUseId: 'tool-1', sessionId: 'session-a', ttlMs: 60_000 });
    repo.queueContinuation({
      toolUseId: 'tool-1',
      sessionId: 'session-a',
      requestBody: { messages: [{ role: 'user', content: [] }] },
      reason: 'late tool_result',
      ttlMs: 60_000,
    });
    db.close();

    db = new Database(dbPath);
    repo = new ToolContinuationRecoveryRepository(db as any);
    const mapping = repo.getToolUse('tool-1');
    const inbox = repo.listPendingInboxForExecution(execution.id);

    expect(mapping?.executionId).toBe(execution.id);
    expect(mapping?.workflowRunId).toBe(run.id);
    expect(mapping?.status).toBe('waiting_rebind');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].toolUseId).toBe('tool-1');
  });

  it('marks execution blocked when the 409 circuit breaker fails forward', () => {
    const { execution } = seedExecution('session-b');
    const repo = new ToolContinuationRecoveryRepository(db as any);
    repo.ensureSchema();
    repo.recordToolUse({ toolUseId: 'tool-2', sessionId: 'session-b', ttlMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      repo.increment409('tool-2', 'orphaned tool_result queued');
    }
    const failed = repo.failToolUse('tool-2', 'circuit breaker tripped');
    const updated = new NodeExecutionRepository(db as any).getById(execution.id)!;

    expect(failed?.status).toBe('failed');
    expect(failed?.attempts409).toBe(3);
    expect(updated.status).toBe('blocked');
    expect(updated.result).toBe('circuit breaker tripped');
  });

  it('does not reopen recovery for consumed tool_use mappings', () => {
    const { execution } = seedExecution('session-c');
    const repo = new ToolContinuationRecoveryRepository(db as any);
    repo.ensureSchema();
    repo.recordToolUse({ toolUseId: 'tool-3', sessionId: 'session-c', ttlMs: 60_000 });
    repo.markConsumed('tool-3');

    const queued = repo.queueContinuation({
      toolUseId: 'tool-3',
      sessionId: 'session-c',
      requestBody: { messages: [{ role: 'user', content: [] }] },
      reason: 'duplicate tool_result retry after success',
      ttlMs: 60_000,
    });
    const incremented = repo.increment409('tool-3', 'duplicate tool_result retry after success');
    const failed = repo.failToolUse('tool-3', 'should not block consumed mapping');
    const mapping = repo.getToolUse('tool-3');
    const updated = new NodeExecutionRepository(db as any).getById(execution.id)!;

    expect(queued.mapping).toBeNull();
    expect(queued.inbox.executionId).toBeNull();
    expect(incremented).toBeNull();
    expect(failed).toBeNull();
    expect(mapping?.status).toBe('consumed');
    expect(mapping?.attempts409).toBe(0);
    expect(updated.status).toBe('in_progress');
    expect(updated.result).toBeNull();
  });

  it('lists pending continuations by session during ghost sub-session rehydrate', () => {
    const { execution } = seedExecution('session-rehydrate');
    const repo = new ToolContinuationRecoveryRepository(db as any);
    repo.ensureSchema();
    repo.recordToolUse({
      toolUseId: 'tool-rehydrate',
      sessionId: 'session-rehydrate',
      ttlMs: 60_000,
    });
    repo.queueContinuation({
      toolUseId: 'tool-rehydrate',
      sessionId: 'session-rehydrate',
      requestBody: { messages: [{ role: 'user', content: [] }] },
      reason: 'continuation arrived while sub-session was rehydrating',
      ttlMs: 60_000,
    });

    const bySession = repo.listPendingInboxForSession('session-rehydrate');
    const byExecution = repo.listPendingInboxForExecution(execution.id);

    expect(bySession).toHaveLength(1);
    expect(bySession[0].toolUseId).toBe('tool-rehydrate');
    expect(bySession[0].executionId).toBe(execution.id);
    expect(bySession[0].id).toBe(byExecution[0].id);
  });

  it('moves expired mappings to waiting_rebind for TTL cleanup races', () => {
    const { execution } = seedExecution('session-d');
    const repo = new ToolContinuationRecoveryRepository(db as any);
    repo.ensureSchema();
    repo.recordToolUse({ toolUseId: 'tool-4', sessionId: 'session-d', ttlMs: 1 });
    repo.markExpired(Date.now() + 60_000);

    const updated = repo.markWaitingRebind(
      'tool-4',
      'tool_result did not arrive before bridge TTL; execution moved to waiting_rebind'
    );
    const updatedExecution = new NodeExecutionRepository(db as any).getById(execution.id)!;

    expect(updated?.status).toBe('waiting_rebind');
    expect(updatedExecution.status).toBe('waiting_rebind');
    expect(updatedExecution.result).toBe(
      'tool_result did not arrive before bridge TTL; execution moved to waiting_rebind'
    );
    expect(updatedExecution.data?.orphanedToolContinuation).toMatchObject({
      state: 'waiting_rebind',
      reason: 'tool_result did not arrive before bridge TTL; execution moved to waiting_rebind',
    });
  });
});
