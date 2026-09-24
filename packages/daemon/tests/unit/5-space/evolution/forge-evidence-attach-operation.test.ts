import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createEvolutionEvidenceAttachOperation } from '../../../../src/lib/evolution/evidence-attach-operation.ts';
import type {
  EvolutionAuditEntry,
  EvolutionAuditWriter,
} from '../../../../src/lib/evolution/admission.ts';
import { EvolutionScopeService } from '../../../../src/lib/evolution/scope-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-evidence-attach';
const OTHER_SPACE_ID = 'space-evidence-attach-other';

function insertSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(id, `/tmp/workspace-${id}`, id, id, Date.now(), Date.now());
}

function makeSession(id: string, spaceId: string, status: string): Session {
  return {
    id,
    title: id,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status,
    config: { tools: {} },
    metadata: { promptProvenance: { source: 'test', hash: 'h', agentId: `agent-${id}` } },
    type: 'space_chat',
    context: { spaceId },
  } as unknown as Session;
}

function makeCtx() {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  insertSpace(db, SPACE_ID);
  insertSpace(db, OTHER_SPACE_ID);

  const taskRepo = new SpaceTaskRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const scopeService = new EvolutionScopeService({
    evolutionRepo: new EvolutionRepository(db),
    spaceRepo: new SpaceRepository(db),
    goalRepo: new SpaceGoalRepository(db),
    taskRepo,
    workflowRunRepo,
  });

  const sessions = new Map<string, Session>([
    ['session-member', makeSession('session-member', SPACE_ID, 'active')],
    ['session-archived', makeSession('session-archived', SPACE_ID, 'archived')],
  ]);
  const sessionOwners = new SpaceLongHorizonAgentRepository(db);
  for (const owned of sessions.values()) {
    sessionOwners.create({
      id: `agent-${owned.id}`,
      spaceId: owned.context?.spaceId as string,
      handle: owned.id,
      sessionId: owned.id,
    });
  }
  const audited: EvolutionAuditEntry[] = [];
  const audit: EvolutionAuditWriter = (entry) => {
    audited.push(entry);
  };

  const attach = createEvolutionEvidenceAttachOperation({
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
    nodeExecutionRepo: new NodeExecutionRepository(db),
    taskRepo,
    workflowRunRepo,
    scopeService,
    audit,
  });

  return {
    db,
    taskRepo,
    workflowRunRepo,
    workflowManager: new SpaceWorkflowManager(new SpaceWorkflowRepository(db)),
    scopeService,
    attach,
    registry: createOperationRegistry([attach]),
    audited,
    createScope: () =>
      scopeService.createScope({
        spaceId: SPACE_ID,
        kind: 'project',
        name: 'Reliability',
        objective: 'Reduce flakes',
      }),
  };
}

const memberCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'long_term_agent',
  agentName: 'alice',
};
const archivedCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-archived',
  spaceId: SPACE_ID,
  role: 'long_term_agent',
};

type AttachedEvidence = {
  accepted: true;
  evidence: { id: string; scopeId: string; kind: string; summary: string; sourceId: string | null };
};

describe('evolution.evidence.attach', () => {
  test('writes a manual note against an explicit scope', async () => {
    const ctx = makeCtx();
    try {
      const scope = ctx.createScope();
      const added = (await ctx.attach.execute(
        { kind: 'manual_note', scopeId: scope.id, summary: 'Flakes down 20%' },
        memberCaller
      )) as AttachedEvidence;
      expect(added.evidence).toMatchObject({
        scopeId: scope.id,
        kind: 'manual_note',
        summary: 'Flakes down 20%',
        sourceId: null,
      });
      expect(ctx.scopeService.listEvidence(scope.id).evidence.map((item) => item.id)).toEqual([
        added.evidence.id,
      ]);
    } finally {
      ctx.db.close();
    }
  });

  test('attaches an in-Space task and rejects a task from another Space', async () => {
    const ctx = makeCtx();
    try {
      const scope = ctx.createScope();
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Evidence task',
        description: '',
      });
      const foreign = ctx.taskRepo.createTask({
        spaceId: OTHER_SPACE_ID,
        title: 'Foreign task',
        description: '',
      });
      const attached = (await ctx.attach.execute(
        { kind: 'task', taskId: task.id, scopeId: scope.id },
        memberCaller
      )) as AttachedEvidence;
      expect(attached.evidence).toMatchObject({ kind: 'task', sourceId: task.id });
      expect(
        await ctx.attach.execute(
          { kind: 'task', taskId: foreign.id, scopeId: scope.id },
          memberCaller
        )
      ).toMatchObject({ accepted: false, reason: 'task_not_found' });
    } finally {
      ctx.db.close();
    }
  });

  test('reports evidence_not_attached when no scope can be resolved for the task', async () => {
    const ctx = makeCtx();
    try {
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Unlinked task',
        description: '',
      });
      expect(
        await ctx.attach.execute({ kind: 'task', taskId: task.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'evidence_not_attached' });
    } finally {
      ctx.db.close();
    }
  });

  test('attaches a workflow run and rejects an unknown run', async () => {
    const ctx = makeCtx();
    try {
      const scope = ctx.createScope();
      const workflow = ctx.workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Forge evidence run',
        nodes: [{ name: 'Work', agents: [{ agentId: 'agent-1', name: 'Coder' }] }],
        tags: [],
      });
      const run = ctx.workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run',
      });
      const attached = (await ctx.attach.execute(
        { kind: 'workflow_run', workflowRunId: run.id, scopeId: scope.id },
        memberCaller
      )) as AttachedEvidence;
      expect(attached.evidence).toMatchObject({ kind: 'workflow_run', sourceId: run.id });
      expect(
        await ctx.attach.execute(
          { kind: 'workflow_run', workflowRunId: 'missing-run', scopeId: scope.id },
          memberCaller
        )
      ).toMatchObject({ accepted: false, reason: 'workflow_run_not_found' });
    } finally {
      ctx.db.close();
    }
  });

  test('rejects a scope outside the caller Space', async () => {
    const ctx = makeCtx();
    try {
      const foreign = ctx.scopeService.createScope({
        spaceId: OTHER_SPACE_ID,
        kind: 'project',
        name: 'Foreign',
        objective: 'Elsewhere',
      });
      expect(
        await ctx.attach.execute(
          { kind: 'manual_note', scopeId: foreign.id, summary: 'should not land' },
          memberCaller
        )
      ).toMatchObject({ accepted: false, reason: 'scope_not_found' });
      expect(ctx.scopeService.listEvidence(foreign.id).evidence).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('denies an archived session and writes no evidence', async () => {
    const ctx = makeCtx();
    try {
      const scope = ctx.createScope();
      expect(
        await ctx.attach.execute(
          { kind: 'manual_note', scopeId: scope.id, summary: 'should not land' },
          archivedCaller
        )
      ).toMatchObject({ accepted: false, reason: 'evolution_denied' });
      expect(ctx.scopeService.listEvidence(scope.id).evidence).toHaveLength(0);
      expect(ctx.audited).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('audits the attach under the operation that was called', async () => {
    const ctx = makeCtx();
    try {
      const scope = ctx.createScope();
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Audited task',
        description: '',
      });
      await ctx.attach.execute({ kind: 'task', taskId: task.id, scopeId: scope.id }, memberCaller);
      expect(ctx.audited).toMatchObject([
        {
          toolName: 'evolution.evidence.attach',
          paramsSummary: { kind: 'task', scopeId: scope.id, taskId: task.id },
          spaceId: SPACE_ID,
          taskId: task.id,
        },
      ]);
    } finally {
      ctx.db.close();
    }
  });
});

describe('invokeOperation', () => {
  test('accepts a manual note and refuses a payload mixing two evidence kinds', async () => {
    const ctx = makeCtx();
    try {
      const scope = ctx.createScope();
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Mixed payload task',
        description: '',
      });
      expect(
        await invokeOperation(
          ctx.registry,
          'evolution.evidence.attach',
          { kind: 'manual_note', scopeId: scope.id, summary: 'note' },
          memberCaller
        )
      ).toMatchObject({
        kind: 'completed',
        value: { accepted: true, evidence: { kind: 'manual_note' } },
      });
      expect(
        await invokeOperation(
          ctx.registry,
          'evolution.evidence.attach',
          { kind: 'manual_note', scopeId: scope.id, summary: 'note', taskId: task.id },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    } finally {
      ctx.db.close();
    }
  });
});
