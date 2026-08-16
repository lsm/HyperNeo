import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { EpisodeJudgePromptInput } from '../../../../src/lib/space/evolution-episode-service';
import { EvolutionEpisodeService } from '../../../../src/lib/space/evolution-episode-service';
import { EvolutionScopeService } from '../../../../src/lib/space/evolution-scope-service';
import {
  GOAL_AUTOMATION_EXECUTE,
  TASK_SCHEDULE_FIRE,
} from '../../../../src/lib/job-queue-constants';
import { handleGoalAutomationExecute } from '../../../../src/lib/job-handlers/goal-automation-execute.handler';
import { handleTaskScheduleFire } from '../../../../src/lib/job-handlers/task-schedule-fire.handler';
import { GoalAutomationService } from '../../../../src/lib/space/goals/goal-automation-service';
import { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service';
import { getLongHorizonAgentTemplate } from '../../../../src/lib/space/agents/long-horizon-agent-templates';
import { syncGoalAutomationSelfNagScheduleForScope } from '../../../../src/lib/rpc-handlers';
import { GoalAutomationCursorRepository } from '../../../../src/storage/repositories/goal-automation-cursor-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

function createJobQueueTable(db: Database): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS job_queue (
			id TEXT PRIMARY KEY,
			queue TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
			payload TEXT NOT NULL DEFAULT '{}',
			result TEXT,
			error TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			max_retries INTEGER NOT NULL DEFAULT 3,
			retry_count INTEGER NOT NULL DEFAULT 0,
			run_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER
		)
	`);
}

describe('long-horizon agent lifecycle integration', () => {
  let db: Database;
  let agentRepo: SpaceLongHorizonAgentRepository;
  let artifactRepo: WorkflowRunArtifactRepository;
  let cursorRepo: GoalAutomationCursorRepository;
  let episodeService: EvolutionEpisodeService;
  let evolutionRepo: EvolutionRepository;
  let goalAutomationService: GoalAutomationService;
  let goalRepo: SpaceGoalRepository;
  let jobQueue: JobQueueRepository;
  let scheduleRepo: TaskScheduleRepository;
  let scheduleService: ScheduleService;
  let scopeService: EvolutionScopeService;
  let spaceRepo: SpaceRepository;
  let taskRepo: SpaceTaskRepository;
  let workflowRepo: SpaceWorkflowRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createJobQueueTable(db);
    agentRepo = new SpaceLongHorizonAgentRepository(db as never);
    artifactRepo = new WorkflowRunArtifactRepository(db as never);
    cursorRepo = new GoalAutomationCursorRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    jobQueue = new JobQueueRepository(db as never);
    scheduleRepo = new TaskScheduleRepository(db as never);
    spaceRepo = new SpaceRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    workflowRepo = new SpaceWorkflowRepository(db as never);
    workflowRunRepo = new SpaceWorkflowRunRepository(db as never);
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/long-horizon-agent-lifecycle',
      slug: 'long-horizon-agent-lifecycle',
      name: 'Long Horizon Agent Lifecycle',
    }).id;

    scheduleService = new ScheduleService({
      db: db as never,
      scheduleRepo,
      jobQueue,
      spaceRepo,
    });
    scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      jobQueue,
    });
    goalAutomationService = new GoalAutomationService({
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      jobQueue,
      evolutionScopeService: scopeService,
    });
    episodeService = new EvolutionEpisodeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      db: db as never,
      judgeEpisode: async (input: EpisodeJudgePromptInput) => ({
        title: `Lifecycle retrospective: ${input.scope.name}`,
        outcomeSummary:
          'The long-horizon agent completed scoped work and produced follow-up learning.',
        findings: [
          {
            domain: 'workflow',
            kind: 'optimization',
            impact: 'medium',
            confidence: 0.91,
            evidence: input.evidence.map((item) => item.id),
            proposedAction: 'Keep capturing agent progress artifacts before task completion.',
          },
        ],
        candidateLessons: [
          {
            rule: 'Capture agent progress as Forge artifacts before marking scoped work done.',
            why: 'Workflow artifacts gave the retrospective enough context to create follow-up work.',
            confidence: 0.91,
            appliesTo: { labels: ['forge', 'long-horizon'] },
          },
        ],
        proposals: [
          {
            title: 'Automate Forge evidence review checklist',
            description: 'Create a checklist task for future long-horizon scoped work.',
            reason: 'The lifecycle evidence showed repeatable review steps worth automating.',
            priority: 'normal',
          },
        ],
      }),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('runs from template-created agent through nudge, Forge trigger, episode, lesson, and proposal task', async () => {
    const template = getLongHorizonAgentTemplate('product-quality-manager.default');
    expect(template).toBeDefined();
    const agent = agentRepo.create({
      spaceId,
      handle: template?.handle ?? 'product-quality-manager',
      displayName: template?.displayName,
      templateKey: template?.key,
      status: 'active',
      instructions: template?.instructions,
      autonomyLevel: template?.suggestedAutonomyLevel,
      toolPermissions: template?.toolPermissions,
    });
    const goal = goalRepo.create({
      spaceId,
      title: 'Improve product quality loops',
      type: 'recurring',
      priority: 'high',
    });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Product quality loop',
      objective: 'Learn from completed product quality tasks.',
      policy: {
        automation: {
          completedTaskThreshold: 1,
          selfNagCronExpression: '0 * * * *',
          maxEvidencePerEpisode: 5,
        },
      },
    });
    agentRepo.assignGoal(agent.id, goal.id, 'manager');
    agentRepo.assignForgeScope(agent.id, scope.id, 'watcher');
    const reminder = agentRepo.createReminder({
      spaceId,
      agentId: agent.id,
      title: 'Review Forge scope after idle',
      body: 'Nudge product quality manager to inspect new scope evidence.',
      triggerType: 'cron',
      cronExpression: '0 * * * *',
      nextRunAt: Date.now(),
      createdBySession: agent.sessionId,
    });

    expect(agent).toMatchObject({
      templateKey: 'product-quality-manager.default',
      status: 'active',
      autonomyLevel: 2,
    });
    expect(agentRepo.listGoals(agent.id)).toEqual([
      expect.objectContaining({ goalId: goal.id, relationship: 'manager' }),
    ]);
    expect(agentRepo.listForgeScopes(agent.id)).toEqual([
      expect.objectContaining({ scopeId: scope.id, relationship: 'watcher' }),
    ]);
    expect(reminder).toMatchObject({
      status: 'active',
      triggerType: 'cron',
      cronExpression: '0 * * * *',
    });

    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Long-horizon coding workflow' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Implement quality signal capture',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Capture quality signal',
      description: 'Run scoped work and persist Forge context.',
      goalId: goal.id,
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
    });
    artifactRepo.upsert({
      id: 'quality-signal-result',
      runId: run.id,
      nodeId: 'Coding',
      artifactType: 'result',
      artifactKey: 'final',
      data: {
        summary: 'Quality signal captured and tests passed.',
        agentId: agent.id,
      },
    });

    taskRepo.updateTask(task.id, { status: 'in_progress' });
    expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');

    taskRepo.updateTask(task.id, {
      status: 'done',
      result: 'Quality signal capture complete; agent idle awaiting next trigger.',
    });
    const evidenceCapture = scopeService.captureCompletedTaskEvidence({ taskId: task.id });

    expect(taskRepo.getTask(task.id)).toMatchObject({
      status: 'done',
      goalId: goal.id,
      evolutionScopeId: scope.id,
    });
    expect(evidenceCapture.scope?.id).toBe(scope.id);
    expect(evidenceCapture.evidence.map((item) => item.kind).sort()).toEqual([
      'artifact',
      'task_result',
    ]);

    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope, db });
    const [schedule] = scheduleService.listSchedules(spaceId, 'active');
    expect(schedule).toMatchObject({
      goalId: goal.id,
      createdByAgent: 'goal-automation-service',
      cronExpression: '0 * * * *',
    });
    expect(schedule.labels).toContain(`scope:${scope.id}`);
    const scheduleFireJob = jobQueue.getJob(schedule.pendingJobId as string);
    expect(scheduleFireJob?.queue).toBe(TASK_SCHEDULE_FIRE);
    const scheduleFire = await handleTaskScheduleFire(
      scheduleFireJob as NonNullable<typeof scheduleFireJob>,
      {
        db: db as never,
        scheduleRepo,
        jobQueue,
        spaceRepo,
        taskRepo,
        goalRepo,
        goalAutomationService,
      }
    );
    expect(scheduleFire).toMatchObject({ scheduleId: schedule.id, skipped: false });
    const [selfNagJob] = jobQueue.dequeue(GOAL_AUTOMATION_EXECUTE, 1);
    expect(selfNagJob.payload).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'self_nag',
      triggerKey: schedule.id,
      scheduleId: schedule.id,
    });
    jobQueue.complete(selfNagJob.id, { skipped: true, reason: 'nudge assertion only' });

    const trigger = goalAutomationService.onTaskCompleted(task.id);
    expect(trigger).toMatchObject({ enqueued: true, reason: 'queued', count: 1 });
    const [triggerJob] = jobQueue.dequeue(GOAL_AUTOMATION_EXECUTE, 1);
    expect(triggerJob.payload).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      triggerKind: 'completed_task_threshold',
      triggerKey: 'threshold:1',
      taskId: task.id,
    });

    const published: Array<{ event: string; data: Record<string, unknown> }> = [];
    const automation = await handleGoalAutomationExecute(triggerJob, {
      db: db as never,
      goalRepo,
      taskRepo,
      evolutionRepo,
      cursorRepo,
      episodeService,
      taskCreatedEventHub: {
        publish: async (event, data) => {
          published.push({ event, data });
        },
      },
    });

    expect(automation).toMatchObject({
      skipped: false,
      goalId: goal.id,
      scopeId: scope.id,
      evidenceCount: evidenceCapture.evidence.length,
    });
    expect(automation.episodeId).toBeString();
    expect(automation.reviewTaskId).toBeString();
    expect(published).toEqual([expect.objectContaining({ event: 'space.task.created' })]);

    const episode = evolutionRepo.getEpisode(automation.episodeId as string);
    expect(episode).toMatchObject({
      scopeId: scope.id,
      status: 'draft',
      title: 'Lifecycle retrospective: Product quality loop',
    });
    expect(episode?.evidenceIds.toSorted()).toEqual(
      evidenceCapture.evidence.map((item) => item.id).toSorted()
    );

    const [lesson] = evolutionRepo.listLessons(scope.id);
    expect(lesson).toMatchObject({
      scopeId: scope.id,
      status: 'candidate',
      rule: 'Capture agent progress as Forge artifacts before marking scoped work done.',
      evidenceEpisodeIds: [automation.episodeId],
    });

    const [proposal] = evolutionRepo.listTaskProposals(scope.id);
    expect(proposal).toMatchObject({
      scopeId: scope.id,
      status: 'proposed',
      title: 'Automate Forge evidence review checklist',
      evidenceEpisodeIds: [automation.episodeId],
    });

    const reviewTask = taskRepo.getTask(automation.reviewTaskId as string);
    expect(reviewTask).toMatchObject({
      goalId: goal.id,
      evolutionScopeId: scope.id,
      title: 'Review Evolution retrospective: Product quality loop',
      status: 'open',
    });
    expect(reviewTask?.labels).toContain('forge');
    expect(reviewTask?.description).toContain(automation.episodeId as string);

    const materialized = episodeService.createTaskFromProposal(proposal.id);
    expect(materialized.proposal).toMatchObject({
      id: proposal.id,
      status: 'created',
      createdTaskId: materialized.task.id,
    });
    expect(materialized.task).toMatchObject({
      spaceId,
      goalId: goal.id,
      evolutionScopeId: scope.id,
      title: 'Automate Forge evidence review checklist',
      status: 'open',
    });

    const cursor = cursorRepo.get(goal.id, scope.id, 'completed_task_threshold', 'threshold:1');
    expect(cursor).toMatchObject({
      goalId: goal.id,
      scopeId: scope.id,
      lastEpisodeId: automation.episodeId,
    });
    expect(cursor?.lastEvidenceCreatedAt).toBeGreaterThan(0);
  });
});
