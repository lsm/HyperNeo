import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createForgeOperations } from '../../../../src/lib/evolution/operations.ts';
import type {
  EvolutionAuditEntry,
  EvolutionAuditWriter,
} from '../../../../src/lib/evolution/admission.ts';
import { EvolutionEpisodeService } from '../../../../src/lib/evolution/episode-service.ts';
import { EvolutionScopeService } from '../../../../src/lib/evolution/scope-service.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-forge-episodes';
const OTHER_SPACE_ID = 'space-forge-episodes-other';

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
    metadata: {},
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

  const spaceRepo = new SpaceRepository(db);
  const goalRepo = new SpaceGoalRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const evolutionRepo = new EvolutionRepository(db);
  const scheduleService = new ScheduleService({
    db,
    scheduleRepo: new TaskScheduleRepository(db),
    jobQueue: new JobQueueRepository(db),
    spaceRepo,
  });
  const goalService = new SpaceGoalService({
    goalRepo,
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    scheduleService,
    db,
  });
  const scopeService = new EvolutionScopeService({
    evolutionRepo,
    spaceRepo,
    goalRepo,
    taskRepo,
    workflowRunRepo,
  });
  const episodeService = new EvolutionEpisodeService({
    evolutionRepo,
    taskRepo,
    workflowRunRepo,
    artifactRepo: new WorkflowRunArtifactRepository(db),
    goalService,
    db,
    judgeEpisode: async () => ({
      title: 'Judged episode',
      outcomeSummary: 'Evidence reviewed through the operations door',
      findings: [
        {
          domain: 'workflow',
          kind: 'optimization',
          impact: 'medium',
          confidence: 0.8,
          evidence: ['manual note'],
          proposedAction: 'Add follow-up task',
        },
      ],
      candidateLessons: [
        {
          appliesTo: ['workflow'],
          rule: 'Keep evidence scoped',
          why: 'Reduces drift',
          confidence: 0.9,
        },
      ],
      proposals: [
        {
          title: 'Judge proposal',
          description: 'Dispatch Forge tools through the operations door',
          reason: 'Judge found next step',
          priority: 'high',
        },
      ],
    }),
  });

  const sessions = new Map<string, Session>([
    ['session-member', makeSession('session-member', SPACE_ID, 'active')],
    ['session-archived', makeSession('session-archived', SPACE_ID, 'archived')],
  ]);

  const audited: EvolutionAuditEntry[] = [];
  const audit: EvolutionAuditWriter = (entry) => {
    audited.push(entry);
  };

  const operations = createForgeOperations({
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
    nodeExecutionRepo: new NodeExecutionRepository(db),
    taskRepo,
    workflowRunRepo,
    scopeService,
    episodeService,
    getGoal: (goalId) => goalService.getGoal(goalId),
    db,
    goalRepo,
    scheduleService,
    audit,
  });
  const registry = createOperationRegistry(operations);
  const op = (name: string): OperationDefinition => {
    const found = registry.get(name);
    if (!found) throw new Error(`operation missing: ${name}`);
    return found;
  };
  return {
    db,
    goalRepo,
    taskRepo,
    evolutionRepo,
    scopeService,
    episodeService,
    audited,
    registry,
    op,
  };
}

const memberCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'ad_hoc_member',
  agentName: 'alice',
};
const workerCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'workflow_worker',
};
const archivedCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-archived',
  spaceId: SPACE_ID,
  role: 'ad_hoc_member',
};

type Ctx = ReturnType<typeof makeCtx>;

function seedScope(ctx: Ctx, spaceId = SPACE_ID, goalId: string | null = null) {
  return ctx.scopeService.createScope({
    spaceId,
    spaceGoalId: goalId,
    kind: 'project',
    name: 'Reliability',
    objective: 'Reduce flakes',
  });
}

async function seedEpisode(ctx: Ctx, scopeId: string) {
  const evidence = ctx.scopeService.addManualNoteEvidence({
    scopeId,
    summary: 'Manual evidence for the judge',
  });
  const created = (await ctx
    .op('evolution.episode.create')
    .execute(
      { scopeId, evidenceIds: [evidence.id], confirmLowConfidence: true },
      memberCaller
    )) as { accepted: true; episode: { id: string } };
  return created;
}

const EPISODE_OPERATION_NAMES = [
  'evolution.episode.create',
  'evolution.episode.update',
  'evolution.lesson.update',
  'evolution.proposal.create',
  'evolution.proposal.task.create',
  'evolution.proposal.update',
  'evolution.rollup.apply',
];

describe('Forge episode catalog', () => {
  test('registers every episode, lesson, proposal, and rollup operation name', () => {
    const ctx = makeCtx();
    try {
      const registered = new Set(ctx.registry.entries.map((entry) => entry.name));
      expect(EPISODE_OPERATION_NAMES.filter((name) => !registered.has(name))).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.episode.create', () => {
  test('generates a draft episode with lessons, proposals, and a preflight', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = (await seedEpisode(ctx, scope.id)) as unknown as {
        accepted: true;
        episode: { id: string; status: string; title: string };
        lessons: Array<{ rule: string }>;
        proposals: Array<{ title: string }>;
        preflight: { level: string };
      };
      expect(created.episode).toMatchObject({ status: 'draft', title: 'Judged episode' });
      expect(created.lessons.map((lesson) => lesson.rule)).toEqual(['Keep evidence scoped']);
      expect(created.proposals.map((proposal) => proposal.title)).toEqual(['Judge proposal']);
      expect(created.preflight.level).toBe('low');
    } finally {
      ctx.db.close();
    }
  });

  test('admits a workflow_worker caller and records the episode on the scope', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const evidence = ctx.scopeService.addManualNoteEvidence({
        scopeId: scope.id,
        summary: 'note',
      });
      expect(
        await ctx
          .op('evolution.episode.create')
          .execute(
            { scopeId: scope.id, evidenceIds: [evidence.id], confirmLowConfidence: true },
            workerCaller
          )
      ).toMatchObject({ accepted: true });
      expect(ctx.episodeService.listReviewBundle(scope.id).episodes).toHaveLength(1);
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.episode.update', () => {
  test('accepts a draft and then refuses to reopen the terminal episode', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = await seedEpisode(ctx, scope.id);
      const acceptedEpisode = (await ctx
        .op('evolution.episode.update')
        .execute({ episodeId: created.episode.id, status: 'accepted' }, memberCaller)) as {
        accepted: true;
        episode: { status: string };
      };
      expect(acceptedEpisode.episode.status).toBe('accepted');
      expect(
        await ctx
          .op('evolution.episode.update')
          .execute({ episodeId: created.episode.id, status: 'dismissed' }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'episode_terminal' });
      expect(ctx.evolutionRepo.getEpisode(created.episode.id)?.status).toBe('accepted');
    } finally {
      ctx.db.close();
    }
  });

  test('denies an archived session and leaves the episode in draft', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = await seedEpisode(ctx, scope.id);
      expect(
        await ctx
          .op('evolution.episode.update')
          .execute({ episodeId: created.episode.id, status: 'accepted' }, archivedCaller)
      ).toMatchObject({ accepted: false, reason: 'forge_denied' });
      expect(ctx.evolutionRepo.getEpisode(created.episode.id)?.status).toBe('draft');
    } finally {
      ctx.db.close();
    }
  });

  test('records the Space on the update audit entry so space-scoped views keep it', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const episode = ctx.episodeService.createEpisode({
        scopeId: scope.id,
        title: 'Audited episode',
      });
      await ctx
        .op('evolution.episode.update')
        .execute({ episodeId: episode.id, title: 'renamed' }, memberCaller);
      const entry = ctx.audited.find((row) => row.toolName === 'evolution.episode.update');
      expect(entry?.spaceId).toBe(SPACE_ID);
    } finally {
      ctx.db.close();
    }
  });

  test('hides an episode owned by another Space behind episode_not_found', async () => {
    const ctx = makeCtx();
    try {
      const foreign = seedScope(ctx, OTHER_SPACE_ID);
      const episode = ctx.episodeService.createEpisode({
        scopeId: foreign.id,
        title: 'Foreign episode',
      });
      expect(
        await ctx
          .op('evolution.episode.update')
          .execute({ episodeId: episode.id, title: 'renamed' }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'episode_not_found' });
      expect(ctx.evolutionRepo.getEpisode(episode.id)?.title).toBe('Foreign episode');
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.lesson.update', () => {
  test('activates a candidate and then refuses to reactivate a dismissed lesson', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      await seedEpisode(ctx, scope.id);
      const lessonId = ctx.episodeService.listLessons(scope.id)[0].id;
      const activated = (await ctx
        .op('evolution.lesson.update')
        .execute({ lessonId, status: 'active' }, memberCaller)) as {
        accepted: true;
        lesson: { status: string };
      };
      expect(activated.lesson.status).toBe('active');
      await ctx
        .op('evolution.lesson.update')
        .execute({ lessonId, status: 'dismissed' }, memberCaller);
      expect(
        await ctx
          .op('evolution.lesson.update')
          .execute({ lessonId, status: 'active' }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'lesson_dismissed' });
      expect(ctx.episodeService.getLesson(lessonId)?.status).toBe('dismissed');
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.proposal.create', () => {
  test('rejects an evidence episode that belongs to another scope', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const other = ctx.scopeService.createScope({
        spaceId: SPACE_ID,
        kind: 'project',
        name: 'Other scope',
        objective: 'elsewhere',
      });
      const episode = ctx.episodeService.createEpisode({
        scopeId: other.id,
        title: 'Elsewhere episode',
      });
      expect(
        await ctx.op('evolution.proposal.create').execute(
          {
            scopeId: scope.id,
            title: 'Cross-scope proposal',
            description: 'd',
            reason: 'r',
            evidenceEpisodeIds: [episode.id],
          },
          memberCaller
        )
      ).toMatchObject({ accepted: false, reason: 'episode_not_found' });
      expect(ctx.episodeService.listTaskProposals(scope.id)).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.proposal.update', () => {
  test('dismisses a proposal and then refuses to reopen it', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = (await ctx
        .op('evolution.proposal.create')
        .execute(
          { scopeId: scope.id, title: 'Manual proposal', description: 'd', reason: 'r' },
          memberCaller
        )) as { accepted: true; proposal: { id: string } };
      await ctx
        .op('evolution.proposal.update')
        .execute({ proposalId: created.proposal.id, status: 'dismissed' }, memberCaller);
      expect(
        await ctx
          .op('evolution.proposal.update')
          .execute({ proposalId: created.proposal.id, status: 'accepted' }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'proposal_dismissed' });
      expect(ctx.episodeService.getTaskProposal(created.proposal.id)?.status).toBe('dismissed');
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.proposal.task.create', () => {
  test('creates the Space task once and returns the same task on a repeat call', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = (await ctx
        .op('evolution.proposal.create')
        .execute(
          { scopeId: scope.id, title: 'Manual proposal', description: 'd', reason: 'r' },
          memberCaller
        )) as { accepted: true; proposal: { id: string } };
      const first = (await ctx
        .op('evolution.proposal.task.create')
        .execute({ proposalId: created.proposal.id }, memberCaller)) as {
        accepted: true;
        proposal: { status: string };
        task: { id: string; evolutionScopeId?: string | null };
      };
      expect(first.proposal.status).toBe('created');
      expect(first.task.evolutionScopeId).toBe(scope.id);
      const second = (await ctx
        .op('evolution.proposal.task.create')
        .execute({ proposalId: created.proposal.id }, memberCaller)) as {
        accepted: true;
        task: { id: string };
      };
      expect(second.task.id).toBe(first.task.id);
      expect(ctx.taskRepo.listBySpace(SPACE_ID, true)).toHaveLength(1);
      const entry = ctx.audited.find((row) => row.toolName === 'evolution.proposal.task.create');
      expect(entry?.spaceId).toBe(SPACE_ID);
    } finally {
      ctx.db.close();
    }
  });

  test('reports task_not_created for a dismissed proposal', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = (await ctx
        .op('evolution.proposal.create')
        .execute(
          { scopeId: scope.id, title: 'Manual proposal', description: 'd', reason: 'r' },
          memberCaller
        )) as { accepted: true; proposal: { id: string } };
      await ctx
        .op('evolution.proposal.update')
        .execute({ proposalId: created.proposal.id, status: 'dismissed' }, memberCaller);
      expect(
        await ctx
          .op('evolution.proposal.task.create')
          .execute({ proposalId: created.proposal.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'task_not_created' });
      expect(ctx.taskRepo.listBySpace(SPACE_ID, true)).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

describe('evolution.rollup.apply', () => {
  test('rolls the episode summary into the recurring goal and refuses a second pass', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Recurring goal',
        description: '',
        type: 'recurring',
      });
      const scope = seedScope(ctx, SPACE_ID, goal.id);
      const created = await seedEpisode(ctx, scope.id);
      const applied = (await ctx.op('evolution.rollup.apply').execute(
        {
          episodeId: created.episode.id,
          goalUpdate: { summary: 'Flakes down', nextSteps: ['keep watching'] },
        },
        memberCaller
      )) as { accepted: true; episode: { status: string }; goal: { summary: string } };
      expect(applied.episode.status).toBe('accepted');
      expect(applied.goal.summary).toBe('Flakes down');
      expect(
        await ctx
          .op('evolution.rollup.apply')
          .execute(
            { episodeId: created.episode.id, goalUpdate: { summary: 'again' } },
            memberCaller
          )
      ).toMatchObject({ accepted: false, reason: 'rollup_already_applied' });
      expect(ctx.goalRepo.getById(goal.id)?.summary).toBe('Flakes down');
    } finally {
      ctx.db.close();
    }
  });

  test('rejects an episode whose scope has no recurring goal', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const created = await seedEpisode(ctx, scope.id);
      expect(
        await ctx
          .op('evolution.rollup.apply')
          .execute({ episodeId: created.episode.id, goalUpdate: { summary: 's' } }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'goal_not_recurring' });
      expect(ctx.evolutionRepo.getEpisode(created.episode.id)?.rollupAppliedAt).toBeNull();
    } finally {
      ctx.db.close();
    }
  });
});

describe('invokeOperation', () => {
  test('validates the rollup and proposal-task results against their declared schemas', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Recurring goal',
        description: '',
        type: 'recurring',
      });
      const scope = seedScope(ctx, SPACE_ID, goal.id);
      const created = await seedEpisode(ctx, scope.id);
      const rollup = await invokeOperation(
        ctx.registry,
        'evolution.rollup.apply',
        { episodeId: created.episode.id, goalUpdate: { summary: 'rolled up' } },
        memberCaller
      );
      expect(rollup).toMatchObject({
        kind: 'completed',
        value: { accepted: true, goal: { id: goal.id, summary: 'rolled up' } },
      });
      const proposals = ctx.episodeService.listTaskProposals(scope.id);
      const task = await invokeOperation(
        ctx.registry,
        'evolution.proposal.task.create',
        { proposalId: proposals[0].id },
        memberCaller
      );
      expect(task).toMatchObject({
        kind: 'completed',
        value: { accepted: true, proposal: { status: 'created' } },
      });
    } finally {
      ctx.db.close();
    }
  });
});
