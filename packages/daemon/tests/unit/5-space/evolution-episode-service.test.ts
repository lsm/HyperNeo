import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import {
  buildEpisodeJudgePrompt,
  EvolutionEpisodeService,
  parseEpisodeJudgeJson,
  resolveEpisodeJudgeModel,
} from '../../../src/lib/space/evolution-episode-service';
import { EvolutionScopeService } from '../../../src/lib/space/evolution-scope-service';
import { clearModelsCache, setModelsCache } from '../../../src/lib/model-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { SpaceGoalEventRepository } from '../../../src/storage/repositories/space-goal-event-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../src/storage/repositories/workflow-run-artifact-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceGoalService } from '../../../src/lib/space/goals/goal-service';
import { CodingArtifactProfile } from '../../../src/lib/space/workflows/coding-artifact-profile';
import type { WorkflowArtifactProfile } from '../../../src/lib/space/runtime/artifact-profile';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionEpisodeService', () => {
  let db: Database;
  let evolutionRepo: EvolutionRepository;
  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let artifactRepo: WorkflowRunArtifactRepository;
  let artifactProfile: WorkflowArtifactProfile;
  let workflowRepo: SpaceWorkflowRepository;
  let goalRepo: SpaceGoalRepository;
  let spaceRepo: SpaceRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceRepo = new SpaceRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    workflowRunRepo = new SpaceWorkflowRunRepository(db as never);
    artifactRepo = new WorkflowRunArtifactRepository(db as never);
    artifactProfile = new CodingArtifactProfile({ db: db as never, artifactRepo });
    workflowRepo = new SpaceWorkflowRepository(db as never);
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/episode-service-test',
      slug: 'episode-service-test',
      name: 'Episode Service Test',
    }).id;
  });

  afterEach(() => {
    clearModelsCache('global');
    db.close();
  });

  it('resolves episode judge model from scope policy before Space default', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Judge scope',
      objective: 'Select judge model',
      policy: { episodeJudgeModel: 'claude-opus-4-5', maxActiveLessons: 5 },
    });
    const input = {
      scope,
      evidence: [],
      metricSnapshots: [],
      tasks: [],
      workflowRuns: [],
      timeWindow: null,
    };

    await expect(
      resolveEpisodeJudgeModel(input, {
        getSpace: () => ({ defaultModel: 'claude-sonnet-4-5' }) as never,
      })
    ).resolves.toEqual({ provider: 'anthropic', modelId: 'claude-opus-4-5' });

    const cleared = evolutionRepo.updateScope(scope.id, {
      policy: { maxActiveLessons: 5 },
    });

    expect(cleared?.policy).toEqual({ maxActiveLessons: 5 });
    await expect(
      resolveEpisodeJudgeModel(
        { ...input, scope: cleared as NonNullable<typeof cleared> },
        { getSpace: () => ({ defaultModel: 'claude-sonnet-4-5' }) as never }
      )
    ).resolves.toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
  });

  it('resolves episode judge model provider from cached model catalog', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'shared-model',
              name: 'Shared model',
              alias: 'shared',
              family: 'sonnet',
              provider: 'openrouter',
              contextWindow: 200000,
              description: 'Shared model ID with provider context',
              releaseDate: '2026-01-01',
              available: true,
            },
          ],
        ],
      ])
    );
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Judge scope',
      objective: 'Select judge model',
      policy: { episodeJudgeModel: 'shared' },
    });

    await expect(
      resolveEpisodeJudgeModel({
        scope,
        evidence: [],
        metricSnapshots: [],
        tasks: [],
        workflowRuns: [],
        timeWindow: null,
      })
    ).resolves.toEqual({ provider: 'openrouter', modelId: 'shared-model' });
  });

  it('resolves exact cached model IDs before alias fallback', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'sonnet',
              name: 'Claude Sonnet',
              alias: 'default',
              family: 'sonnet',
              provider: 'anthropic',
              contextWindow: 200000,
              description: 'Fallback sonnet',
              releaseDate: '2026-01-01',
              available: true,
            },
            {
              id: 'default',
              name: 'Custom default',
              alias: 'custom-default',
              family: 'sonnet',
              provider: 'openrouter',
              contextWindow: 200000,
              description: 'Custom endpoint default model',
              releaseDate: '2026-01-01',
              available: true,
            },
          ],
        ],
      ])
    );
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Judge scope',
      objective: 'Select judge model',
      policy: { episodeJudgeModel: 'default' },
    });

    await expect(
      resolveEpisodeJudgeModel({
        scope,
        evidence: [],
        metricSnapshots: [],
        tasks: [],
        workflowRuns: [],
        timeWindow: null,
      })
    ).resolves.toEqual({ provider: 'openrouter', modelId: 'default' });
  });

  it('resolves scope judge model with stored provider identity', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'shared-model',
              name: 'Anthropic shared',
              alias: 'shared',
              family: 'sonnet',
              provider: 'anthropic',
              contextWindow: 200000,
              description: 'Anthropic shared model',
              releaseDate: '2026-01-01',
              available: true,
            },
            {
              id: 'shared-model',
              name: 'OpenRouter shared',
              alias: 'shared',
              family: 'sonnet',
              provider: 'openrouter',
              contextWindow: 200000,
              description: 'OpenRouter shared model',
              releaseDate: '2026-01-01',
              available: true,
            },
          ],
        ],
      ])
    );
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Judge scope',
      objective: 'Select judge model',
      policy: { episodeJudgeModel: 'shared-model', episodeJudgeProvider: 'openrouter' },
    });

    await expect(
      resolveEpisodeJudgeModel({
        scope,
        evidence: [],
        metricSnapshots: [],
        tasks: [],
        workflowRuns: [],
        timeWindow: null,
      })
    ).resolves.toEqual({ provider: 'openrouter', modelId: 'shared-model' });
  });

  it('warns and blocks manual-note-only evidence without explicit confirmation', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Thin evidence',
      objective: 'Avoid generic findings',
    });
    const note = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Operator thinks the work went well',
    });
    let judgeCalled = false;
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => {
        judgeCalled = true;
        return { title: 'Should not run', outcomeSummary: 'Nope', findings: [] };
      },
    });
    const input = service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [note.id] });
    const prompt = buildEpisodeJudgePrompt(input);

    expect(input.preflight.level).toBe('low');
    expect(input.preflight.requiresConfirmation).toBe(true);
    expect(input.preflight.warnings).toContain(
      'Only manual notes selected; findings will be low confidence without task results or artifacts.'
    );
    expect(input.preflight.warnings).toContain('No task evidence selected.');
    expect(prompt).toContain('Evidence quality preflight');
    expect(prompt).toContain('low');
    await expect(
      service.createFromEvidence({ scopeId: scope.id, evidenceIds: [note.id] })
    ).rejects.toThrow('Low-confidence evidence requires explicit confirmation');
    expect(judgeCalled).toBe(false);
  });

  it('passes task plus workflow artifact evidence through preflight', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Artifact-backed evidence',
      objective: 'Trust concrete outcomes',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Ship Forge preflight',
      description: 'Add preflight',
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(task.id, {
      status: 'done',
      result: 'PR merged after CI and QA passed',
      reportedSummary: 'Completed with artifact-backed validation',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Code workflow' });
    const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Forge run' });
    artifactRepo.upsert({
      id: 'artifact-quality',
      runId: run.id,
      nodeId: 'qa',
      artifactType: 'decision',
      artifactKey: 'qa',
      data: { summary: 'QA passed, CI green, PR https://github.com/lsm/neokai/pull/1 merged' },
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
      summary: 'Task linked to completed work',
    });
    const digestEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'friction_digest',
      sourceId: task.id,
      summary: 'Friction digest linked to completed work',
    });
    const workflowTask = taskRepo.createTask({
      spaceId,
      title: 'Supervised completion gate',
      description: 'Report completion before human approval',
      workflowRunId: run.id,
    });
    taskRepo.updateTask(workflowTask.id, {
      reportedStatus: 'done',
      reportedSummary: 'Ready for review after validation',
    });
    const artifactEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'artifact',
      sourceId: run.id,
      summary: 'Workflow artifact captured QA and merge outcome',
    });
    const errorEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'error',
      sourceId: run.id,
      summary: 'Workflow run had retryable error',
    });
    const scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });
    const listedWithoutContext = scopeService.listEvidence(scope.id);
    expect(listedWithoutContext.preflightContext).toBeUndefined();

    const listed = scopeService.listEvidence(scope.id, { includePreflightContext: true });
    const taskContext = listed.preflightContext?.tasks.find(
      (item) => item.evidenceId === taskEvidence.id
    )?.task;
    const digestTaskContext = listed.preflightContext?.tasks.find(
      (item) => item.evidenceId === digestEvidence.id
    )?.task;
    const runContext = listed.preflightContext?.workflowRuns[0];
    expect(taskContext).toEqual({
      title: 'Ship Forge preflight',
      status: 'done',
      reportedStatus: null,
      reportedSummary: 'Completed with artifact-backed validation',
      result: 'PR merged after CI and QA passed',
    });
    expect(digestTaskContext).toEqual(taskContext);
    expect('description' in (taskContext ?? {})).toBe(false);
    expect('metadata' in (taskContext ?? {})).toBe(false);
    const largePayload = 'x'.repeat(1000);
    artifactRepo.upsert({
      id: 'artifact-large',
      runId: run.id,
      nodeId: 'logs',
      artifactType: 'log',
      artifactKey: 'large',
      data: {
        summary: 'Generic artifact',
        result: 'CI passed and PR merged',
        details: 'Tool-specific field says QA passed after merge validation',
        message: largePayload,
      },
    });
    for (let index = 0; index < 8; index++) {
      artifactRepo.upsert({
        id: `artifact-extra-${index}`,
        runId: run.id,
        nodeId: 'extra',
        artifactType: 'decision',
        artifactKey: `extra-${index}`,
        data: { summary: 'later artifact outside preflight window' },
      });
    }
    const listedWithArtifacts = scopeService.listEvidence(scope.id, {
      includePreflightContext: true,
    });
    const cappedRunContext = listedWithArtifacts.preflightContext?.workflowRuns[0];
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    const input = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id, artifactEvidence.id],
    });

    expect(input.preflight.level).toBe('high');
    expect(input.preflight.requiresConfirmation).toBe(false);
    expect(input.preflight.counts.taskResults).toBe(1);
    expect(input.preflight.counts.workflowArtifacts).toBe(1);
    expect(input.preflight.counts.outcomes).toBeGreaterThanOrEqual(3);
    expect(runContext?.evidenceIds).toContain(artifactEvidence.id);
    expect(runContext?.evidenceIds).toContain(errorEvidence.id);
    expect(cappedRunContext?.artifacts).toHaveLength(8);
    expect(cappedRunContext?.artifacts[0]?.data.summary).toContain('QA passed');
    expect(cappedRunContext?.artifacts[1]?.data.summary).toContain('Generic artifact');
    expect(cappedRunContext?.artifacts[1]?.data.summary).toContain('CI passed and PR merged');
    expect(cappedRunContext?.artifacts[1]?.data.summary).toContain(
      'Tool-specific field says QA passed after merge validation'
    );
    expect(cappedRunContext?.artifacts[1]?.data.summary.length).toBeLessThanOrEqual(501);
    expect(cappedRunContext?.artifacts.some((artifact) => 'large' in artifact.data)).toBe(false);
  });

  it('builds preflight context with one batched query per kind (no per-item N+1)', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Batched preflight',
      objective: 'Bound preflight round-trips',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Batched workflow' });
    const taskIds: string[] = [];
    const runIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const task = taskRepo.createTask({
        spaceId,
        title: `Task ${index}`,
        description: 'd',
        evolutionScopeId: scope.id,
      });
      taskIds.push(task.id);
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'task',
        sourceId: task.id,
        summary: `task evidence ${index}`,
      });
      const run = workflowRunRepo.createRun({
        spaceId,
        workflowId: workflow.id,
        title: `Run ${index}`,
      });
      runIds.push(run.id);
      artifactRepo.upsert({
        id: `art-${index}`,
        runId: run.id,
        nodeId: 'n',
        artifactType: 'decision',
        artifactKey: `k-${index}`,
        data: { summary: `artifact ${index}` },
      });
      evolutionRepo.createEvidence({
        scopeId: scope.id,
        kind: 'artifact',
        sourceId: run.id,
        summary: `run evidence ${index}`,
      });
    }

    const calls = {
      getTask: 0,
      getTasksByIds: 0,
      getRun: 0,
      getRunsByIds: 0,
      listByWorkflowRunIncludingArchived: 0,
      listByWorkflowRunIdsIncludingArchived: 0,
      listByRun: 0,
      listByRuns: 0,
    };
    const wrap = <T extends object, K extends string>(
      target: T,
      key: K,
      tally: keyof typeof calls
    ) => {
      const original = (target[key] as (...args: unknown[]) => unknown).bind(target);
      Object.assign(target, {
        [key]: (...args: unknown[]) => {
          calls[tally]++;
          return original(...args);
        },
      });
    };
    wrap(taskRepo, 'getTask', 'getTask');
    wrap(taskRepo, 'getTasksByIds', 'getTasksByIds');
    wrap(taskRepo, 'listByWorkflowRunIncludingArchived', 'listByWorkflowRunIncludingArchived');
    wrap(
      taskRepo,
      'listByWorkflowRunIdsIncludingArchived',
      'listByWorkflowRunIdsIncludingArchived'
    );
    wrap(workflowRunRepo, 'getRun', 'getRun');
    wrap(workflowRunRepo, 'getRunsByIds', 'getRunsByIds');
    wrap(artifactRepo, 'listByRun', 'listByRun');
    wrap(artifactRepo, 'listByRuns', 'listByRuns');

    const scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
    });
    const listed = scopeService.listEvidence(scope.id, { includePreflightContext: true });

    expect(calls.getTask).toBe(0);
    expect(calls.getRun).toBe(0);
    expect(calls.listByWorkflowRunIncludingArchived).toBe(0);
    expect(calls.listByRun).toBe(0);
    expect(calls.getTasksByIds).toBe(1);
    expect(calls.getRunsByIds).toBe(1);
    expect(calls.listByWorkflowRunIdsIncludingArchived).toBe(1);
    expect(calls.listByRuns).toBe(1);

    expect(listed.preflightContext?.tasks).toHaveLength(3);
    expect(listed.preflightContext?.workflowRuns).toHaveLength(3);
    expect(
      listed.preflightContext?.workflowRuns.every((entry) => runIds.includes(entry.run.id))
    ).toBe(true);
    expect(listed.preflightContext?.workflowRuns.flatMap((entry) => entry.artifacts)).toHaveLength(
      3
    );
  });

  it('metric snapshot improves evidence readiness', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Metrics evidence',
      objective: 'Use measurements',
    });
    const note = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Manual note says review completed',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });
    const before = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [note.id],
    }).preflight;
    evolutionRepo.createMetricSnapshot({
      scopeId: scope.id,
      values: { comments: 2 },
      source: 'manual',
      note: 'Review comments decreased',
    });
    const after = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [note.id],
    }).preflight;

    expect(after.score).toBeGreaterThan(before.score);
    expect(after.counts.metricSnapshots).toBe(1);
    expect(after.warnings).not.toContain('No metric snapshot context selected.');
  });

  it('builds episode input with task results, workflow artifacts, metrics, and notes', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Review loop',
      objective: 'Reduce review churn',
      metricDefinitions: [{ key: 'comments', label: 'Comments', direction: 'decrease' }],
      policy: { episodeJudgeModel: 'claude-sonnet-4-6' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Fix review feedback',
      description: 'Address comments',
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(task.id, {
      result: 'PR updated and tests pass',
      reportedSummary: 'Resolved reviewer comments',
    });
    const taskWithoutResult = taskRepo.createTask({
      spaceId,
      title: 'Fix without explicit result',
      description: 'Only reportedSummary',
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(taskWithoutResult.id, {
      result: null,
      reportedSummary: 'Fallback summary visible to judge',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Code workflow' });
    const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Run one' });
    artifactRepo.upsert({
      id: 'artifact-1',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'Implementation ready' },
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
      createdAt: 100,
    });
    const taskWithoutResultEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: taskWithoutResult.id,
      summary: 'Task without explicit result',
      createdAt: 110,
    });
    const runEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'artifact',
      sourceId: run.id,
      summary: 'Workflow completed',
      createdAt: 200,
    });
    const errorEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'error',
      sourceId: run.id,
      summary: 'Same workflow run had rework',
      createdAt: 225,
    });
    const note = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Reviewer saw repeated confusion',
      createdAt: 150,
    });
    evolutionRepo.createMetricSnapshot({
      scopeId: scope.id,
      values: { comments: 2 },
      source: 'manual',
      note: 'After review',
      capturedAt: 125,
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    const input = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [
        taskEvidence.id,
        taskWithoutResultEvidence.id,
        runEvidence.id,
        errorEvidence.id,
        note.id,
      ],
    });
    const prompt = buildEpisodeJudgePrompt(input);

    expect(input.timeWindow).toEqual({ start: 100, end: 225 });
    expect(input.workflowRuns).toHaveLength(1);
    expect(input.workflowRuns[0]?.run.id).toBe(run.id);
    expect(input.tasks).toHaveLength(2);
    expect(prompt).toContain('Reduce review churn');
    expect(prompt).toContain('Resolved reviewer comments');
    expect(prompt).toContain('PR updated and tests pass');
    expect(prompt).toContain('Fallback summary visible to judge');
    expect(prompt).toContain('Implementation ready');
    expect(prompt).toContain('Reviewer saw repeated confusion');
    expect(prompt).toContain('comments');
    expect(prompt).toContain('claude-sonnet-4-6');
  });

  it('deduplicates task context when task and trace evidence reference the same task', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Trace dedupe',
      objective: 'Avoid duplicate task prompt context',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Trace task',
      description: 'Has task and trace evidence',
      evolutionScopeId: scope.id,
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
      summary: 'Task evidence',
    });
    const retryEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'retry_loop',
      sourceId: task.id,
      summary: 'Retry loop evidence',
    });
    const conversationEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'conversation_friction',
      sourceId: task.id,
      summary: 'Conversation friction evidence',
    });
    const digestEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'friction_digest',
      sourceId: task.id,
      summary: 'Friction digest evidence',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    const input = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id, retryEvidence.id, conversationEvidence.id, digestEvidence.id],
    });

    expect(input.evidence).toHaveLength(4);
    expect(input.tasks).toHaveLength(1);
    expect(input.tasks[0]?.task.id).toBe(task.id);

    const digestOnlyInput = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [digestEvidence.id],
    });
    expect(digestOnlyInput.tasks).toHaveLength(1);
    expect(digestOnlyInput.tasks[0]?.task.id).toBe(task.id);
    expect(digestOnlyInput.preflight.counts.taskResults).toBe(1);
    expect(digestOnlyInput.preflight.warnings).not.toContain('No task evidence selected.');
  });

  it('resolves judge model from scope policy before Space default', async () => {
    const scopedInput = {
      scope: evolutionRepo.createScope({
        spaceId,
        kind: 'custom',
        name: 'Scoped model',
        objective: 'Use scope override',
        policy: { episodeJudgeModel: 'claude-opus-4-7' },
      }),
      evidence: [],
      metricSnapshots: [],
      tasks: [],
      workflowRuns: [],
      timeWindow: undefined,
    };

    expect(await resolveEpisodeJudgeModel(scopedInput, spaceRepo)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    });
  });

  it('falls back to Space default model when scope has no judge model', async () => {
    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/episode-service-default-model',
      slug: 'episode-service-default-model',
      name: 'Episode Service Default Model',
      defaultModel: 'claude-sonnet-4-6',
    });
    const input = {
      scope: evolutionRepo.createScope({
        spaceId: space.id,
        kind: 'custom',
        name: 'Space model',
        objective: 'Use space default',
      }),
      evidence: [],
      metricSnapshots: [],
      tasks: [],
      workflowRuns: [],
      timeWindow: undefined,
    };

    expect(await resolveEpisodeJudgeModel(input, spaceRepo)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('includes evidence metadata so backfilled task artifacts reach the judge', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Forge dogfood',
      objective: 'Generate useful episodes from completed task evidence',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Implement Forge storage',
      description: 'Add storage and shared contracts',
      evolutionScopeId: scope.id,
    });
    const evidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
      summary: 'Task completed; workflow artifacts contain review and QA results.',
      metadata: {
        artifacts: [
          {
            type: 'result',
            summary: 'Requested changes: missing review-path tests',
            prUrl: 'https://github.com/lsm/neokai/pull/1963',
          },
        ],
      },
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    const prompt = buildEpisodeJudgePrompt(
      service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [evidence.id] })
    );

    expect(prompt).toContain('Requested changes: missing review-path tests');
    expect(prompt).toContain('https://github.com/lsm/neokai/pull/1963');
  });

  it('truncates manual note metadata in every prompt section', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Manual note metadata',
      objective: 'Keep prompt metadata bounded',
    });
    const note = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Manual note with oversized metadata',
      metadata: { marker: 'metadata-marker', payload: 'x'.repeat(1500) },
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    const prompt = buildEpisodeJudgePrompt(
      service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [note.id] })
    );

    expect(prompt).toContain('metadata-marker');
    expect(prompt).not.toContain('x'.repeat(1300));
  });

  it('includes existing active/candidate lessons and open proposals in the judge prompt', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Dedup context',
      objective: 'Avoid duplicate lessons and proposals',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Scoped Forge task',
      description: 'Completed work with evidence',
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(task.id, {
      status: 'done',
      result: 'PR merged with tests',
      reportedSummary: 'Completed',
    });
    const evidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed with PR merge',
    });
    evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      appliesTo: ['workflow'],
      rule: 'Always run evidence-quality preflight before judging an episode',
      why: 'Manual notes alone produce generic findings',
      confidence: 0.85,
    });
    evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'candidate',
      appliesTo: ['tool'],
      rule: 'Prefer trace evidence over manual notes for episode generation',
      why: 'Trace evidence carries concrete tool failure data',
      confidence: 0.6,
    });
    evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Add conversation friction dashboard',
      description: 'Surface friction patterns in the Forge UI',
      reason: 'Friction evidence is captured but not visible to operators',
      priority: 'normal',
      status: 'proposed',
    });
    evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Add verification triage automation',
      description: 'Auto-trigger verification after repeated failures',
      reason: 'Verification failures are a leading friction source',
      priority: 'high',
      status: 'accepted',
    });
    evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'dismissed',
      appliesTo: ['workflow'],
      rule: 'Dismissed lesson should not appear',
      why: 'Rejected by operator',
      confidence: 0.1,
    });
    evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Dismissed proposal should not appear',
      description: 'Should be filtered out',
      reason: 'Dismissed',
      priority: 'low',
      status: 'dismissed',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    const input = service.buildEpisodeInput({ scopeId: scope.id, evidenceIds: [evidence.id] });
    const prompt = buildEpisodeJudgePrompt(input);

    expect(input.existingLessons).toHaveLength(2);
    expect(
      input.existingLessons.some(
        (l) => l.rule === 'Always run evidence-quality preflight before judging an episode'
      )
    ).toBe(true);
    expect(
      input.existingLessons.some(
        (l) => l.rule === 'Prefer trace evidence over manual notes for episode generation'
      )
    ).toBe(true);
    expect(input.existingProposals).toHaveLength(2);
    expect(
      input.existingProposals.some((p) => p.title === 'Add conversation friction dashboard')
    ).toBe(true);
    expect(
      input.existingProposals.some((p) => p.title === 'Add verification triage automation')
    ).toBe(true);
    expect(prompt).toContain('Existing accepted and candidate lessons in this scope');
    expect(prompt).toContain('Always run evidence-quality preflight before judging an episode');
    expect(prompt).toContain('Open proposals in this scope');
    expect(prompt).toContain('Add conversation friction dashboard');
    expect(prompt).toContain('Surface friction patterns in the Forge UI');
    expect(prompt).toContain('Friction evidence is captured but not visible to operators');
    expect(prompt).not.toContain('Dismissed');
    expect(prompt).toContain(
      'omit any that duplicate or substantially overlap with the items above'
    );
  });

  it('parses fenced judge JSON and clamps confidence', () => {
    const output = parseEpisodeJudgeJson(`\n\`\`\`json\n{
			"title": "Review churn reduced",
			"outcomeSummary": "Task landed with fewer comments.",
			"findings": [{
				"domain": "workflow",
				"kind": "optimization",
				"impact": "medium",
				"confidence": 1.4,
				"evidence": ["ev-1"],
				"proposedAction": "Keep reviewer checklist"
			}],
			"candidateLessons": [{
				"appliesTo": ["workflow"],
				"rule": "Use checklist before PR",
				"why": "It reduced comments",
				"confidence": 0.8
			}],
			"proposals": [{
				"title": "Add checklist template",
				"description": "Create review checklist",
				"reason": "Avoid repeat misses",
				"priority": "normal"
			}]
		}\n\`\`\``);

    expect(output.title).toBe('Review churn reduced');
    expect(output.findings[0]?.confidence).toBe(1);
    expect(output.candidateLessons?.[0]?.rule).toBe('Use checklist before PR');
    expect(output.proposals?.[0]?.title).toBe('Add checklist template');
  });

  it('rejects malformed judge JSON and invalid enum values', () => {
    expect(() => parseEpisodeJudgeJson('Failed to authenticate')).toThrow(
      'Episode judge returned non-JSON text: Failed to authenticate'
    );
    expect(() => parseEpisodeJudgeJson('{ nope')).toThrow('Episode judge returned invalid JSON');
    expect(() =>
      parseEpisodeJudgeJson(
        JSON.stringify({
          title: 'Bad domain',
          outcomeSummary: 'Bad domain',
          findings: [
            {
              domain: 'bad',
              kind: 'friction',
              impact: 'low',
              confidence: 0.5,
              evidence: [],
              proposedAction: 'Fix it',
            },
          ],
        })
      )
    ).toThrow('finding.domain must be one of');
  });

  it('atomically creates a scoped SpaceTask from a proposal with dependencies', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Improve review loop',
      type: 'recurring',
    });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Review scope',
      objective: 'Track review health',
    });
    const episode = evolutionRepo.createEpisode({
      scopeId: scope.id,
      title: 'Manual rollup',
      outcomeSummary: 'Review friction found',
    });
    const proposal = evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Improve review UI',
      description: 'Make actions clearer',
      reason: 'Users miss next steps',
      priority: 'high',
      evidenceEpisodeIds: [episode.id],
    });
    const dependency = taskRepo.createTask({
      spaceId,
      title: 'Dependency task',
      description: 'Must finish first',
    });
    const publishedEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      db,
      taskCreatedEventHub: {
        publish: async (event, data) => {
          publishedEvents.push({ event, data });
        },
      },
    });

    const result = service.createTaskFromProposal(proposal.id, { dependsOn: [dependency.id] });
    const duplicate = service.createTaskFromProposal(proposal.id);

    expect(duplicate.task.id).toBe(result.task.id);
    expect(
      taskRepo.listBySpace(spaceId).filter((item) => item.title === 'Improve review UI')
    ).toHaveLength(1);
    expect(taskRepo.getTask(result.task.id)?.dependsOn).toEqual([dependency.id]);
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      event: 'space.task.created',
      data: { spaceId, taskId: result.task.id, task: result.task },
    });
    expect(result.proposal).toMatchObject({
      status: 'created',
      createdTaskId: result.task.id,
    });
    expect(result.task).toMatchObject({
      spaceId,
      goalId: goal.id,
      evolutionScopeId: scope.id,
      title: 'Improve review UI',
      priority: 'high',
      dependsOn: [dependency.id],
    });
    expect(result.task.description).toContain('Make actions clearer');
    expect(result.task.description).toContain('Proposal reason:\nUsers miss next steps');
    expect(result.task.description).toContain('Evolution evidence episodes:');
    expect(result.task.description).toContain(episode.id);
  });

  function createGoalService(): SpaceGoalService {
    return new SpaceGoalService({
      goalRepo,
      goalEventRepo: new SpaceGoalEventRepository(db as never),
      taskRepo,
      spaceRepo,
      scheduleService: {} as never,
    });
  }

  it('applies accepted rollup fields to the linked recurring goal', () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Recurring review goal',
      type: 'recurring',
      summary: 'Old summary',
      progress: 20,
      nextSteps: ['Old step'],
    });
    const scope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Review scope',
      objective: 'Track review health',
    });
    const episode = evolutionRepo.createEpisode({
      scopeId: scope.id,
      title: 'Weekly rollup',
      outcomeSummary: 'Progress improved',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      goalService: createGoalService(),
    });

    const result = service.applyRollupGoalUpdate({
      episodeId: episode.id,
      goalUpdate: {
        summary: 'New rollup summary',
        progress: 75,
        nextSteps: ['Create follow-up task'],
        metrics: { latency: 3 },
      },
    });
    const updated = service.updateEpisode(episode.id, { rollupAppliedAt: null });

    expect(result.episode.status).toBe('accepted');
    expect(result.episode.rollupAppliedAt).toBeNumber();
    expect(updated?.rollupAppliedAt).toBe(result.episode.rollupAppliedAt);
    expect(result.goal).toMatchObject({
      summary: 'New rollup summary',
      progress: 20,
      nextSteps: ['Create follow-up task'],
      metrics: { latency: 3 },
    });
    expect(goalRepo.getById(goal.id)?.progress).toBe(20);
  });

  it('rejects invalid proposal-to-task requests', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Review scope',
      objective: 'Track review health',
    });
    const dismissed = evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Dismissed task',
      description: 'Do not create',
      reason: 'Rejected',
      status: 'dismissed',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    expect(() => service.createTaskFromProposal(dismissed.id)).toThrow(
      'Dismissed proposal cannot create a task'
    );
    expect(() => service.createTaskFromProposal('missing-proposal')).toThrow(
      'TaskProposal not found: missing-proposal'
    );
  });

  it('rejects proposal-to-task dependencies missing from the scope space', () => {
    const otherSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/other-space',
      slug: 'other-space',
      name: 'Other Space',
    }).id;
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Dependency scope',
      objective: 'Validate dependency space',
    });
    const proposal = evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Dependent task',
      description: 'Should reject cross-space deps',
      reason: 'Avoid invalid dependency graph',
    });
    const otherSpaceTask = taskRepo.createTask({
      spaceId: otherSpaceId,
      title: 'Other space task',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });

    expect(() =>
      service.createTaskFromProposal(proposal.id, { dependsOn: [otherSpaceTask.id] })
    ).toThrow(`Dependency task not found in space: ${otherSpaceTask.id}`);
  });

  it('rejects self-dependency and cycles during proposal-to-task creation', () => {
    const taskId = 'proposal-cycle-task';
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Dependency scope',
      objective: 'Validate dependency graph',
    });
    const selfProposal = evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Self-dependent task',
      description: 'Should reject self dependency',
      reason: 'Avoid impossible dependency ordering',
    });
    const cycleProposal = evolutionRepo.createTaskProposal({
      scopeId: scope.id,
      title: 'Cycle task',
      description: 'Should reject bad graph',
      reason: 'Avoid impossible dependency ordering',
    });
    const upstream = taskRepo.createTask({
      spaceId,
      title: 'Upstream task',
      dependsOn: [taskId],
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      taskIdFactory: () => taskId,
    });

    expect(() => service.createTaskFromProposal(selfProposal.id, { dependsOn: [taskId] })).toThrow(
      'A task cannot depend on itself'
    );
    expect(() =>
      service.createTaskFromProposal(cycleProposal.id, { dependsOn: [upstream.id] })
    ).toThrow('Adding these dependencies would create a circular dependency');
  });

  it('rejects invalid rollup writeback requests', () => {
    const goal = goalRepo.create({ spaceId, title: 'Recurring review goal', type: 'recurring' });
    const oneShotGoal = goalRepo.create({ spaceId, title: 'One-shot goal', type: 'one_shot' });
    const linkedScope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Linked scope',
      objective: 'Track review health',
    });
    const unlinkedScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Unlinked scope',
      objective: 'Track review health',
    });
    const oneShotScope = evolutionRepo.createScope({
      spaceId,
      spaceGoalId: oneShotGoal.id,
      kind: 'mission',
      name: 'One-shot scope',
      objective: 'Track review health',
    });
    const draftEpisode = evolutionRepo.createEpisode({
      scopeId: linkedScope.id,
      title: 'Draft rollup',
    });
    const unlinkedEpisode = evolutionRepo.createEpisode({
      scopeId: unlinkedScope.id,
      title: 'Unlinked rollup',
    });
    const oneShotEpisode = evolutionRepo.createEpisode({
      scopeId: oneShotScope.id,
      title: 'One-shot rollup',
    });
    const dismissedEpisode = evolutionRepo.createEpisode({
      scopeId: linkedScope.id,
      title: 'Dismissed rollup',
      status: 'dismissed',
    });
    const serviceWithoutGoalService = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      goalService: createGoalService(),
    });
    const serviceOnlyEpisode = evolutionRepo.createEpisode({
      scopeId: linkedScope.id,
      title: 'Service-only rollup',
    });
    const request = { episodeId: serviceOnlyEpisode.id, goalUpdate: { summary: 'Rollup' } };
    const failingGoalService = {
      getGoal: (goalId: string) => goalRepo.getById(goalId),
      updateGoal: () => {
        throw new Error('goal update failed');
      },
    };
    const failingService = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      goalService: failingGoalService,
    });
    const applied = service.applyRollupGoalUpdate({
      episodeId: draftEpisode.id,
      goalUpdate: { summary: 'Applied once' },
    });

    expect(applied.episode.status).toBe('accepted');
    expect(applied.episode.rollupAppliedAt).toBeNumber();
    expect(() =>
      service.applyRollupGoalUpdate({
        episodeId: draftEpisode.id,
        goalUpdate: { summary: 'Rollup' },
      })
    ).toThrow('Episode rollup already applied');
    expect(() => failingService.applyRollupGoalUpdate(request)).toThrow('goal update failed');
    expect(evolutionRepo.getEpisode(serviceOnlyEpisode.id)?.status).toBe('draft');
    expect(() => serviceWithoutGoalService.applyRollupGoalUpdate(request)).toThrow(
      'SpaceGoalService is required'
    );
    expect(() =>
      service.applyRollupGoalUpdate({
        episodeId: unlinkedEpisode.id,
        goalUpdate: { summary: 'Rollup' },
      })
    ).toThrow('Episode scope is not linked to a recurring goal');
    expect(() =>
      service.applyRollupGoalUpdate({
        episodeId: oneShotEpisode.id,
        goalUpdate: { summary: 'Rollup' },
      })
    ).toThrow('Episode scope is not linked to a recurring goal');
    expect(() =>
      service.applyRollupGoalUpdate({
        episodeId: dismissedEpisode.id,
        goalUpdate: { summary: 'Rollup' },
      })
    ).toThrow('Dismissed episode cannot accept rollup');
  });

  it('exercises the full Forge episode lifecycle with deduped evidence and accepted rollup context', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Improve Forge evidence quality',
      description: 'Catch cross-boundary evidence regressions before review',
      type: 'recurring',
      summary: 'Old lifecycle summary',
      progress: 40,
      metrics: { completedTasks: 0, rollups: 0 },
    });
    const scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });
    const scope = scopeService.createScopeFromGoal({
      spaceGoalId: goal.id,
      name: 'Improve Forge evidence quality',
      objective: 'Validate evidence collection across the full episode lifecycle',
      metricDefinitions: [
        { key: 'completedTasks', label: 'Completed tasks', direction: 'increase' },
        { key: 'rollups', label: 'Rollups applied', direction: 'increase' },
      ],
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Coding workflow' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Forge lifecycle test run',
    });
    workflowRunRepo.updateRun(run.id, { status: 'done' });
    artifactRepo.upsert({
      id: 'artifact-forge-lifecycle-result',
      runId: run.id,
      nodeId: 'Coding',
      artifactType: 'decision',
      artifactKey: 'final',
      data: {
        summary:
          'Lifecycle coverage captured episode acceptance, proposal task creation, and rollup writeback.',
        pr_url: 'https://github.com/lsm/neokai/pull/455',
      },
    });
    const completedTask = taskRepo.createTask({
      spaceId,
      title: 'Add Forge lifecycle integration test',
      description: 'Cover evidence, episode, lesson, proposal, and rollup paths together',
      goalId: goal.id,
      workflowRunId: run.id,
      priority: 'high',
    });
    taskRepo.updateTask(completedTask.id, {
      status: 'done',
      result: 'Initial lifecycle result before dedup update',
      reportedSummary: 'Evidence captured through completion path',
    });

    const firstCapture = scopeService.captureCompletedTaskEvidence({ taskId: completedTask.id });
    taskRepo.updateTask(completedTask.id, {
      result: 'Updated lifecycle result after repeated completion capture',
      reportedSummary: 'Updated evidence should replace auto-captured metadata',
    });
    const secondCapture = scopeService.captureCompletedTaskEvidence({ taskId: completedTask.id });
    const { evidence: metricEvidence } = scopeService.addMetricSnapshotEvidence({
      scopeId: scope.id,
      values: { completedTasks: 1, rollups: 0 },
      source: 'integration-test',
      note: 'Lifecycle evidence before rollup',
    });
    const manualEvidence = scopeService.addManualNoteEvidence({
      scopeId: scope.id,
      summary: 'Accepted episodes must retain findings and evidence IDs for downstream actions.',
    });
    const autoEvidence = evolutionRepo
      .listEvidence(scope.id)
      .filter((item) => item.metadata.autoCaptured);
    const taskEvidence = autoEvidence.find((item) => item.kind === 'task_result');
    const artifactEvidence = autoEvidence.find((item) => item.kind === 'artifact');
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      goalService: createGoalService(),
      judgeEpisode: async (input) => ({
        title: 'Forge evidence lifecycle episode',
        outcomeSummary: `Lifecycle judge saw ${input.evidence.length} evidence items and ${input.tasks.length} task context.`,
        findings: [
          {
            domain: 'workflow',
            kind: 'regression',
            impact: 'high',
            confidence: 0.9,
            evidence: input.evidence.map((item) => item.id),
            proposedAction: 'Keep full Forge lifecycle covered by one integration test.',
          },
        ],
        candidateLessons: [
          {
            appliesTo: ['workflow', 'test'],
            rule: 'Exercise Forge evidence, episode, proposal, and rollup paths together.',
            why: 'Boundary bugs escape isolated unit tests.',
            confidence: 0.88,
          },
        ],
        proposals: [
          {
            title: 'Harden Forge lifecycle assertions',
            description:
              'Add assertions that accepted episodes keep enough context for follow-up work.',
            reason: 'Accepted rollups must not erase evidence IDs or findings used downstream.',
            priority: 'high',
          },
        ],
      }),
    });

    expect(firstCapture.scope?.id).toBe(scope.id);
    expect(firstCapture.evidence.map((item) => item.kind).sort()).toEqual([
      'artifact',
      'task_result',
    ]);
    expect(secondCapture.evidence.map((item) => item.id).sort()).toEqual(
      firstCapture.evidence.map((item) => item.id).sort()
    );
    expect(autoEvidence.map((item) => item.kind).sort()).toEqual(['artifact', 'task_result']);
    expect(taskEvidence?.metadata.result).toBe(
      'Updated lifecycle result after repeated completion capture'
    );
    expect(artifactEvidence?.metadata.artifactCount).toBe(1);

    const episodeResult = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [
        taskEvidence?.id,
        artifactEvidence?.id,
        metricEvidence.id,
        manualEvidence.id,
      ].filter((id): id is string => Boolean(id)),
    });
    const rollup = service.applyRollupGoalUpdate({
      episodeId: episodeResult.episode.id,
      goalUpdate: {
        summary: 'Forge lifecycle test accepted evidence and wrote rollup.',
        progress: 70,
        nextSteps: ['Run follow-up proposal task with active lesson context'],
        metrics: { completedTasks: 1, rollups: 1 },
      },
    });
    const activeLesson = service.updateLesson(episodeResult.lessons[0].id, { status: 'active' });
    const created = service.createTaskFromProposal(episodeResult.proposals[0].id);
    const acceptedEpisode = service.getEpisode(episodeResult.episode.id);

    expect(episodeResult.episode).toMatchObject({
      status: 'draft',
      title: 'Forge evidence lifecycle episode',
    });
    expect(episodeResult.preflight.level).toBe('high');
    expect(episodeResult.preflight.counts.taskResults).toBe(1);
    expect(episodeResult.preflight.counts.workflowArtifacts).toBe(1);
    expect(episodeResult.lessons[0]).toMatchObject({
      status: 'candidate',
      evidenceEpisodeIds: [episodeResult.episode.id],
    });
    expect(episodeResult.proposals[0]).toMatchObject({
      status: 'proposed',
      evidenceEpisodeIds: [episodeResult.episode.id],
    });
    expect(rollup.episode.status).toBe('accepted');
    expect(rollup.episode.rollupAppliedAt).toBeNumber();
    expect(rollup.goal).toMatchObject({
      summary: 'Forge lifecycle test accepted evidence and wrote rollup.',
      progress: 40,
      nextSteps: ['Run follow-up proposal task with active lesson context'],
      metrics: { completedTasks: 1, rollups: 1 },
    });
    expect(acceptedEpisode).toMatchObject({
      status: 'accepted',
      evidenceIds: episodeResult.episode.evidenceIds,
      findings: episodeResult.episode.findings,
      outcomeSummary: episodeResult.episode.outcomeSummary,
    });
    expect(created.task).toMatchObject({
      goalId: goal.id,
      evolutionScopeId: scope.id,
      title: 'Harden Forge lifecycle assertions',
      priority: 'high',
    });
    expect(created.task.description).toContain(episodeResult.episode.id);
    expect(created.task.description).toContain(
      'Accepted rollups must not erase evidence IDs or findings used downstream.'
    );
    expect(scopeService.selectActiveLessonsForTask({ taskId: created.task.id })).toMatchObject([
      {
        id: activeLesson?.id,
        rule: 'Exercise Forge evidence, episode, proposal, and rollup paths together.',
      },
    ]);
  });

  it('dogfoods the Forge MVP loop from recurring goal to next scoped task', async () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Build HyperNeo Forge MVP',
      description: 'Verify the scoped learning loop end to end',
      type: 'recurring',
      metrics: {
        completedTasks: 0,
        acceptedLessons: 0,
        reusedLessons: 0,
        repeatedFailures: 1,
        timeToNextTaskHours: null,
      },
    });
    const scopeService = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
    });
    const scope = scopeService.createScopeFromGoal({
      spaceGoalId: goal.id,
      name: 'Build HyperNeo Forge MVP',
      objective: 'Verify a usable end-to-end Forge scoped learning loop',
      metricDefinitions: [
        { key: 'completedTasks', label: 'Completed tasks', direction: 'increase' },
        { key: 'acceptedLessons', label: 'Accepted lessons', direction: 'increase' },
        { key: 'reusedLessons', label: 'Reused lessons', direction: 'increase' },
        { key: 'repeatedFailures', label: 'Repeated failures', direction: 'decrease' },
        {
          key: 'timeToNextTaskHours',
          label: 'Hours from completion to next task',
          direction: 'decrease',
        },
      ],
    });
    const completedTask = taskRepo.createTask({
      spaceId,
      title: 'Harden Forge MVP loop',
      description: 'Dogfood Forge against its own implementation',
      goalId: goal.id,
      createdByTaskScheduleId: 'forge-recurring-schedule',
    });
    taskRepo.updateTask(completedTask.id, {
      status: 'done',
      result: 'Scope, evidence, episode, lesson, proposal, and rollup paths verified.',
      reportedSummary: 'Forge loop completed with one accepted lesson and a follow-up task.',
    });
    const taskEvidence = scopeService.attachTaskEvidence({ taskId: completedTask.id });
    const { evidence: metricEvidence } = scopeService.addMetricSnapshotEvidence({
      scopeId: scope.id,
      values: {
        completedTasks: 1,
        acceptedLessons: 1,
        reusedLessons: 0,
        repeatedFailures: 0,
        timeToNextTaskHours: 2,
      },
      source: 'dogfood',
      note: 'First complete Forge MVP dogfood pass',
    });
    const manualEvidence = scopeService.addManualNoteEvidence({
      scopeId: scope.id,
      summary: 'Lesson injection should be visible in the next scoped task prompt.',
    });
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      goalService: createGoalService(),
      judgeEpisode: async (input) => ({
        title: 'Forge MVP dogfood episode',
        outcomeSummary: `Reviewed ${input.evidence.length} scoped evidence items.`,
        findings: [
          {
            domain: 'hyperneo_product',
            kind: 'friction',
            impact: 'medium',
            confidence: 0.8,
            evidence: input.evidence.map((item) => item.id),
            proposedAction: 'Keep end-to-end dogfood metrics visible in Forge.',
          },
        ],
        candidateLessons: [
          {
            appliesTo: ['workflow', 'prompt'],
            rule: 'Attach completed scoped tasks as evidence before judging an episode.',
            why: 'The judge needs task result context to produce reusable lessons.',
            confidence: 0.85,
          },
        ],
        proposals: [
          {
            title: 'Polish Forge empty states',
            description: 'Make empty states explain the next action in the learning loop.',
            reason: 'Dogfood showed first-time operators need clearer prompts.',
            priority: 'normal',
          },
        ],
      }),
    });

    const episodeResult = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id, metricEvidence.id, manualEvidence.id],
    });
    const activeLesson = service.updateLesson(episodeResult.lessons[0].id, { status: 'active' });
    const created = service.createTaskFromProposal(episodeResult.proposals[0].id);
    const rollup = service.applyRollupGoalUpdate({
      episodeId: episodeResult.episode.id,
      goalUpdate: {
        summary: 'Forge MVP dogfood loop completed once.',
        progress: 80,
        nextSteps: ['Run the created follow-up task with injected lesson context'],
        metrics: {
          completedTasks: 1,
          acceptedLessons: 1,
          reusedLessons: 1,
          repeatedFailures: 0,
          timeToNextTaskHours: 2,
        },
      },
    });

    expect(scope).toMatchObject({
      spaceGoalId: goal.id,
      name: 'Build HyperNeo Forge MVP',
      kind: 'mission',
    });
    expect(taskEvidence.metadata).toMatchObject({
      status: 'done',
      createdByTaskScheduleId: 'forge-recurring-schedule',
    });
    expect(episodeResult.episode.status).toBe('draft');
    expect(episodeResult.episode.evidenceIds).toContain(taskEvidence.id);
    expect(episodeResult.episode.evidenceIds).toContain(metricEvidence.id);
    expect(episodeResult.episode.evidenceIds).toContain(manualEvidence.id);
    expect(activeLesson).toMatchObject({ status: 'active' });
    expect(created.task).toMatchObject({
      goalId: goal.id,
      evolutionScopeId: scope.id,
      title: 'Polish Forge empty states',
    });
    expect(scopeService.selectActiveLessonsForTask({ taskId: created.task.id })).toMatchObject([
      {
        id: activeLesson?.id,
        rule: 'Attach completed scoped tasks as evidence before judging an episode.',
      },
    ]);
    expect(rollup.episode.status).toBe('accepted');
    expect(rollup.episode.rollupAppliedAt).toBeNumber();
    expect(rollup.goal).toMatchObject({
      summary: 'Forge MVP dogfood loop completed once.',
      progress: 0,
      nextSteps: ['Run the created follow-up task with injected lesson context'],
      metrics: {
        completedTasks: 1,
        acceptedLessons: 1,
        reusedLessons: 1,
        repeatedFailures: 0,
        timeToNextTaskHours: 2,
      },
    });
  });

  it('persists draft episode, candidate lessons, and proposals from judge output', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Draft scope',
      objective: 'Create draft',
    });
    const evidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'manual_note',
      summary: 'Manual observation',
    });
    let judgePreflight: unknown;
    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async (input) => {
        judgePreflight = input.preflight;
        return {
          title: 'Manual episode',
          outcomeSummary: 'Observation summarized',
          findings: [
            {
              domain: 'hyperneo_product',
              kind: 'friction',
              impact: 'high',
              confidence: 0.9,
              evidence: [evidence.id],
              proposedAction: 'Reduce UI friction',
            },
          ],
          candidateLessons: [
            {
              appliesTo: ['ui'],
              rule: 'Surface next step',
              why: 'User got stuck',
              confidence: 0.7,
            },
          ],
          proposals: [
            {
              title: 'Improve review UI',
              description: 'Add clearer actions',
              reason: 'Reduce friction',
              priority: 'high',
            },
          ],
        };
      },
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [evidence.id],
      confirmLowConfidence: true,
    });

    expect(judgePreflight).toMatchObject({
      level: 'low',
      requiresConfirmation: true,
      warnings: expect.arrayContaining([
        'Only manual notes selected; findings will be low confidence without task results or artifacts.',
      ]),
    });
    expect(result.preflight).toBe(judgePreflight);
    expect(result.preflight.score).toBeGreaterThanOrEqual(0);
    expect(result.episode).toMatchObject({
      status: 'draft',
      title: 'Manual episode',
      evidenceIds: [evidence.id],
    });
    expect(result.lessons[0]).toMatchObject({
      status: 'candidate',
      rule: 'Surface next step',
      evidenceEpisodeIds: [result.episode.id],
    });
    expect(result.proposals[0]).toMatchObject({
      status: 'proposed',
      title: 'Improve review UI',
      evidenceEpisodeIds: [result.episode.id],
    });
  });

  it('preflight artifact diagnostics flag omitted workflow artifacts from the scope', () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Artifact omission',
      objective: 'Surface missing artifact context',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Add preflight diagnostics',
      description: 'Surface artifact gaps',
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(task.id, {
      status: 'done',
      result: 'PR merged with tests',
      reportedSummary: 'Completed with task-only evidence',
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
      summary: 'Task evidence only',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Workflow' });
    const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Run' });
    const workflowRunEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
      summary: 'Workflow run evidence available but not selected',
    });
    const artifactEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'artifact',
      sourceId: run.id,
      summary: 'Workflow artifact evidence available but not selected',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
    });
    const input = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
    });

    expect(input.preflight.counts.workflowArtifacts).toBe(0);
    expect(input.preflight.artifactDiagnostics.status).toBe('available_omitted');
    expect(input.preflight.artifactDiagnostics.availableKinds).toEqual([
      'artifact',
      'workflow_run',
    ]);
    expect(input.preflight.artifactDiagnostics.omittedCount).toBe(2);
    const recommendationText = input.preflight.artifactDiagnostics.recommendations.join(' ');
    expect(recommendationText).toMatch(/workflow_run evidence/);
    expect(recommendationText).toMatch(/artifact evidence/);
    expect(recommendationText).toMatch(/2 workflow artifact evidence rows/);

    const allSelectedInput = service.buildEpisodeInput({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id, workflowRunEvidence.id, artifactEvidence.id],
    });
    expect(allSelectedInput.preflight.artifactDiagnostics.status).toBe('selected');
    expect(allSelectedInput.preflight.artifactDiagnostics.recommendations).toEqual([]);

    const emptyScope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Empty artifacts',
      objective: 'No artifact context available',
    });
    const emptyScopeTask = taskRepo.createTask({
      spaceId,
      title: 'Task without artifacts',
      description: 'No artifact evidence in scope',
      evolutionScopeId: emptyScope.id,
    });
    const emptyScopeTaskEvidence = evolutionRepo.createEvidence({
      scopeId: emptyScope.id,
      kind: 'task',
      sourceId: emptyScopeTask.id,
      summary: 'Task only',
    });
    const emptyScopeInput = service.buildEpisodeInput({
      scopeId: emptyScope.id,
      evidenceIds: [emptyScopeTaskEvidence.id],
    });
    expect(emptyScopeInput.preflight.artifactDiagnostics.status).toBe('none_available');
    expect(emptyScopeInput.preflight.artifactDiagnostics.availableKinds).toEqual([]);
  });

  it('emits a result-artifact gap finding when a selected task has no result but its run has a result artifact', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Result artifact gap',
      objective: 'Detect missing task results',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-1',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task with missing result',
      description: 'Result artifact exists but task.result is empty',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: null, reportedSummary: 'Fallback summary' });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });
    const runEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
      summary: 'Workflow run completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id, runEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(1);
    expect(result.episode.findings[0]).toMatchObject({
      domain: 'hyperneo_product',
      kind: 'bug',
      impact: 'medium',
      confidence: 0.9,
      evidence: expect.arrayContaining([taskEvidence.id, runEvidence.id]),
      proposedAction: expect.stringContaining('Backfill task.result'),
    });
  });

  it('detects a result-artifact gap even when the workflow run evidence is not selected', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Unselected run gap',
      objective: 'Detect gaps without run evidence',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-2',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task with missing result',
      description: 'Result artifact exists but task.result is empty',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(1);
    expect(result.episode.findings[0]).toMatchObject({
      domain: 'hyperneo_product',
      kind: 'bug',
      evidence: [taskEvidence.id],
      proposedAction: expect.stringContaining('Backfill task.result'),
    });
  });

  it('does not emit a result-artifact gap finding when the task already has a result', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'No gap',
      objective: 'Skip tasks that already have results',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-3',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task with result',
      description: 'Task.result is populated',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: 'PR merged', reportedSummary: 'Done' });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('does not emit a result-artifact gap finding when no result artifact exists', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'No artifact',
      objective: 'Skip when there is no result artifact',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task without result artifact',
      description: 'No result artifact exists',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('detects a result-artifact gap when the result artifact is outside the truncated run context', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Truncated run context',
      objective: 'Detect gaps beyond MAX_ARTIFACTS_PER_RUN',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    for (let i = 0; i < 8; i++) {
      artifactRepo.upsert({
        id: `progress-artifact-${i}`,
        runId: run.id,
        nodeId: 'coder',
        artifactType: 'note',
        artifactKey: `progress-${i}`,
        data: { step: i },
      });
    }
    artifactRepo.upsert({
      id: 'result-artifact-truncated',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task with truncated result artifact',
      description: 'Result artifact exists beyond the 8-artifact cap',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });
    const runEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
      summary: 'Workflow run completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id, runEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(1);
    expect(result.episode.findings[0]).toMatchObject({
      domain: 'hyperneo_product',
      kind: 'bug',
      evidence: expect.arrayContaining([taskEvidence.id, runEvidence.id]),
    });
  });

  it('does not emit a result-artifact gap finding for non-terminal tasks', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'In-progress task',
      objective: 'Skip tasks that are not yet terminal',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-in-progress',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task still in progress',
      description: 'Result artifact exists but task is not terminal',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'in_progress',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task in progress',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('does not emit a result-artifact gap finding when the result artifact lacks a summary', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'No summary artifact',
      objective: 'Skip result artifacts without readable summary',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-no-summary',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { prUrl: 'https://github.com/lsm/neokai/pull/123' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task with metadata-only result artifact',
      description: 'Result artifact has no summary to backfill',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('emits a result-artifact gap finding when task.result is the generic fallback string', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Generic result fallback',
      objective: 'Treat generic fallback result as missing',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-generic',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task with generic result',
      description: 'task.result is the generic fallback string',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, {
      result:
        'An unexpected error occurred. Please try again or contact support if the issue persists.',
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(1);
    expect(result.episode.findings[0]).toMatchObject({
      domain: 'hyperneo_product',
      kind: 'bug',
      evidence: [taskEvidence.id],
      proposedAction: expect.stringContaining('Backfill task.result'),
    });
  });

  it('does not emit a result-artifact gap finding for approved tasks', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Approved task',
      objective: 'Skip approved tasks that have not reached done',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-approved',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Approved task without result',
      description: 'Approved tasks may lack result until mark_complete',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'approved',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task approved',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('does not emit a result-artifact gap finding for cancelled tasks', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Cancelled task',
      objective: 'Skip cancelled tasks',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-cancelled',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'Partial work before cancellation' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Cancelled task without result',
      description: 'Cancelled tasks do not require a result backfill',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'cancelled',
    });
    taskRepo.updateTask(task.id, { result: null });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task cancelled',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('does not emit a result-artifact gap finding for archived tasks that were cancelled', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Archived cancelled task',
      objective: 'Skip archived tasks originally cancelled',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-archived-cancelled',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'Partial work before cancellation' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Archived cancelled task without result',
      description: 'Archived after cancellation',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'cancelled',
    });
    taskRepo.updateTask(task.id, {
      result: null,
      status: 'archived',
    });
    const taskEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task archived after cancellation',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [taskEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(0);
  });

  it('detects a result-artifact gap from workflow-run evidence when no task evidence is selected', async () => {
    const scope = evolutionRepo.createScope({
      spaceId,
      kind: 'custom',
      name: 'Artifact-only episode',
      objective: 'Detect gaps via run tasks',
    });
    const workflow = workflowRepo.createWorkflow({ spaceId, name: 'Release' });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Release run',
    });
    artifactRepo.upsert({
      id: 'result-artifact-run-only',
      runId: run.id,
      nodeId: 'coder',
      artifactType: 'decision',
      artifactKey: 'final',
      data: { summary: 'PR merged' },
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Task selected via run',
      description: 'Task has missing result but is only reachable through run tasks',
      evolutionScopeId: scope.id,
      workflowRunId: run.id,
      status: 'done',
    });
    taskRepo.updateTask(task.id, { result: null });
    const runEvidence = evolutionRepo.createEvidence({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
      summary: 'Workflow run completed',
    });

    const service = new EvolutionEpisodeService({
      evolutionRepo,
      taskRepo,
      workflowRunRepo,
      artifactRepo,
      artifactProfile,
      judgeEpisode: async () => ({
        title: 'Episode',
        outcomeSummary: '',
        findings: [],
      }),
    });

    const result = await service.createFromEvidence({
      scopeId: scope.id,
      evidenceIds: [runEvidence.id],
      confirmLowConfidence: true,
    });

    expect(result.episode.findings).toHaveLength(1);
    expect(result.episode.findings[0]).toMatchObject({
      domain: 'hyperneo_product',
      kind: 'bug',
      evidence: [runEvidence.id],
      proposedAction: expect.stringContaining('Backfill task.result'),
    });
  });
});
