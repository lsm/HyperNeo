import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import {
  EvolutionScopeService,
  extractArtifactDetail,
  mergeEvolutionPolicy,
  rankLessonsByTaskRelevance,
} from '../../../src/lib/space/evolution-scope-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionScopeService', () => {
  let db: Database;
  let service: EvolutionScopeService;
  let evolutionRepo: EvolutionRepository;
  let goalRepo: SpaceGoalRepository;
  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowRepo: SpaceWorkflowRepository;
  let spaceRepo: SpaceRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);

    spaceRepo = new SpaceRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    goalRepo = new SpaceGoalRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    workflowRunRepo = new SpaceWorkflowRunRepository(db as never);
    workflowRepo = new SpaceWorkflowRepository(db as never);
    service = new EvolutionScopeService({
      evolutionRepo,
      spaceRepo,
      goalRepo,
      taskRepo,
      workflowRunRepo,
    });

    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/forge-service-test',
      slug: 'forge-service-test',
      name: 'Forge Service Test',
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates a mission scope from an existing recurring SpaceGoal', () => {
    const goal = goalRepo.create({
      spaceId,
      title: 'Recurring Forge check-in',
      description: 'Reduce review churn over time',
      type: 'recurring',
    });

    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });

    expect(scope).toMatchObject({
      spaceId,
      spaceGoalId: goal.id,
      kind: 'mission',
      name: 'Recurring Forge check-in',
      objective: 'Reduce review churn over time',
    });
    expect(service.resolveScopeForGoal({ spaceGoalId: goal.id })?.id).toBe(scope.id);
  });

  it('merges policy patches into the stored policy', () => {
    const scope = service.createScope({
      spaceId,
      kind: 'custom',
      name: 'Patch policy',
      objective: 'Preserve concurrent settings',
      policy: {
        episodeJudgeModel: 'claude-sonnet-4-6',
        episodeJudgeProvider: 'anthropic',
        automation: {
          completedTaskThreshold: 7,
          selfNagCronExpression: '0 0 * * *',
        },
      },
    });

    const updated = service.updateScope(scope.id, {
      policyPatch: {
        automation: { completedTaskAutomationEnabled: false },
      },
    });

    expect(updated?.policy).toEqual({
      episodeJudgeModel: 'claude-sonnet-4-6',
      episodeJudgeProvider: 'anthropic',
      automation: {
        completedTaskThreshold: 7,
        completedTaskAutomationEnabled: false,
        selfNagCronExpression: '0 0 * * *',
      },
    });
  });

  it('attaches scheduled goal task evidence by resolving scope through spaceGoalId', () => {
    const goal = goalRepo.create({ spaceId, title: 'Weekly check-in', type: 'recurring' });
    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Scheduled check-in task',
      description: 'Review goal progress',
      goalId: goal.id,
      createdByTaskScheduleId: 'schedule-1',
    });

    const evidence = service.attachTaskEvidence({ taskId: task.id });

    expect(evidence).toMatchObject({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
      summary: 'Task #1: Scheduled check-in task',
    });
    expect(evidence.metadata).toMatchObject({
      workflowRunId: null,
      createdByTaskScheduleId: 'schedule-1',
    });
  });

  it('attaches task evidence through explicit evolutionScopeId before goal fallback', () => {
    const scope = service.createScope({
      spaceId,
      kind: 'custom',
      name: 'Explicit task scope',
      objective: 'Collect custom workflow evidence',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Custom scoped task',
      description: 'Has explicit evolution scope but no goal',
      evolutionScopeId: scope.id,
    });

    const evidence = service.attachTaskEvidence({ taskId: task.id });

    expect(evidence).toMatchObject({
      scopeId: scope.id,
      kind: 'task',
      sourceId: task.id,
    });
  });

  it('resolves task scope through linked goal and selects top 3 active lessons', () => {
    const goal = goalRepo.create({ spaceId, title: 'Weekly check-in', type: 'recurring' });
    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Scheduled check-in task',
      description: 'Review goal progress',
      goalId: goal.id,
    });
    for (let index = 1; index <= 5; index++) {
      const lesson = evolutionRepo.createLesson({
        scopeId: scope.id,
        status: index === 5 ? 'candidate' : 'active',
        rule: `Lesson ${index}`,
        why: `Why ${index}`,
      });
      evolutionRepo.updateLesson(lesson.id, { confidence: index / 10 });
    }

    expect(service.resolveScopeForTask({ taskId: task.id })?.id).toBe(scope.id);
    expect(service.selectActiveLessonsForTask({ taskId: task.id })).toHaveLength(3);
    expect(
      service
        .selectActiveLessonsForTask({ taskId: task.id })
        .every((lesson) => lesson.status === 'active')
    ).toBe(true);
  });

  it('ranks lessons by tag overlap with task labels', () => {
    const goal = goalRepo.create({ spaceId, title: 'Tag ranking check', type: 'recurring' });
    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Fix gate writer config',
      description: 'Update gate permissions for reviewer node',
      goalId: goal.id,
      labels: ['workflow', 'ui'],
    });
    const lessonA = evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      rule: 'Always verify gate writers include reviewer node',
      why: 'Missing writer causes deadlock',
      appliesTo: ['workflow'],
    });
    const lessonB = evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      rule: 'Use bun test for daemon unit tests',
      why: 'Consistency with test suite',
      appliesTo: ['tool'],
    });

    const selected = service.selectActiveLessonsForTask({ taskId: task.id, limit: 1 });

    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(lessonA.id);
  });

  it('ranks lessons by keyword overlap when tags do not match', () => {
    const goal = goalRepo.create({ spaceId, title: 'Keyword ranking check', type: 'recurring' });
    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Refactor context panel switch cases',
      description: 'Add missing forge branch in ContextPanel.tsx routing',
      goalId: goal.id,
    });
    const lessonA = evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      rule: 'When adding new switch case branches in ContextPanel.tsx, preserve existing cases',
      why: 'PR 1968 caught missing forge case',
    });
    const lessonB = evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      rule: 'Use GitHub CLI for all PR operations',
      why: 'Avoids web UI inconsistency',
    });

    const selected = service.selectActiveLessonsForTask({ taskId: task.id, limit: 1 });

    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(lessonA.id);
  });

  it('falls back to confidence and recency when no tag or keyword overlap', () => {
    const goal = goalRepo.create({ spaceId, title: 'Fallback ranking check', type: 'recurring' });
    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Unrelated task',
      description: 'No overlap with lessons',
      goalId: goal.id,
    });
    const lessonA = evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      rule: 'Lesson A',
      why: 'Why A',
    });
    const lessonB = evolutionRepo.createLesson({
      scopeId: scope.id,
      status: 'active',
      rule: 'Lesson B',
      why: 'Why B',
    });
    evolutionRepo.updateLesson(lessonA.id, { confidence: 1.0 });
    evolutionRepo.updateLesson(lessonB.id, { confidence: 0.0 });

    const selected = service.selectActiveLessonsForTask({ taskId: task.id, limit: 1 });

    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(lessonA.id);
  });

  it('returns no active lessons for unscoped tasks', () => {
    const task = taskRepo.createTask({
      spaceId,
      title: 'Unscoped task',
      description: 'No goal or explicit scope',
    });

    expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
    expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
  });

  it('returns no active lessons for tasks with stale goalId', () => {
    const task = taskRepo.createTask({
      spaceId,
      title: 'Stale goal task',
      description: 'References missing goal',
      goalId: 'missing-goal',
    });

    expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
    expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
    expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
      'EvolutionScope not found for SpaceGoal: missing-goal'
    );
  });

  it('returns no active lessons for tasks with stale evolutionScopeId', () => {
    const task = taskRepo.createTask({
      spaceId,
      title: 'Stale scoped task',
      description: 'References missing scope',
      evolutionScopeId: 'missing-scope',
    });

    expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
    expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
    expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
      'EvolutionScope not found: missing-scope'
    );
  });

  it('returns no active lessons for tasks with cross-space evolutionScopeId', () => {
    const otherSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/other-forge-service-test',
      slug: 'other-forge-service-test',
      name: 'Other Forge Service Test',
    }).id;
    const otherScope = service.createScope({
      spaceId: otherSpaceId,
      kind: 'custom',
      name: 'Other scope',
      objective: 'Own unrelated lessons',
    });
    evolutionRepo.createLesson({
      scopeId: otherScope.id,
      status: 'active',
      rule: 'Unrelated lesson',
      why: 'Different space',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Cross-space scoped task',
      description: 'References another space scope',
      evolutionScopeId: otherScope.id,
    });

    expect(service.resolveScopeForTask({ taskId: task.id })).toBeNull();
    expect(service.selectActiveLessonsForTask({ taskId: task.id })).toEqual([]);
    expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
      'Task and scope must belong to the same space'
    );
  });

  it('attaches workflow-run evidence through explicit evolutionScopeId parent task', () => {
    const scope = service.createScope({
      spaceId,
      kind: 'custom',
      name: 'Explicit workflow scope',
      objective: 'Collect workflow evidence',
    });
    const workflow = workflowRepo.createWorkflow({
      spaceId,
      name: 'Custom workflow',
      description: 'Run custom scope',
    });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Custom run',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Custom workflow task',
      description: 'Has explicit evolution scope but no goal',
      evolutionScopeId: scope.id,
    });
    taskRepo.updateTask(task.id, { workflowRunId: run.id });

    const evidence = service.attachWorkflowRunEvidence({ workflowRunId: run.id });

    expect(evidence).toMatchObject({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
    });
  });

  it('attaches workflow-run evidence through its goal-linked parent task', () => {
    const goal = goalRepo.create({ spaceId, title: 'Runtime check-in', type: 'recurring' });
    const scope = service.createScopeFromGoal({ spaceGoalId: goal.id });
    const workflow = workflowRepo.createWorkflow({
      spaceId,
      name: 'Check-in workflow',
      description: 'Run check-in',
    });
    const run = workflowRunRepo.createRun({
      spaceId,
      workflowId: workflow.id,
      title: 'Check-in run',
    });
    const task = taskRepo.createTask({
      spaceId,
      title: 'Check-in task',
      description: 'Review goal progress',
      goalId: goal.id,
    });
    taskRepo.updateTask(task.id, { workflowRunId: run.id });

    const evidence = service.attachWorkflowRunEvidence({ workflowRunId: run.id });

    expect(evidence).toMatchObject({
      scopeId: scope.id,
      kind: 'workflow_run',
      sourceId: run.id,
      summary: 'Workflow run: Check-in run',
    });
    expect(evidence.metadata.workflowId).toBe(workflow.id);
  });

  it('adds manual notes and metric snapshots to scope timeline', () => {
    const scope = service.createScope({
      spaceId,
      kind: 'custom',
      name: 'Manual timeline',
      objective: 'Collect evidence',
    });
    const note = service.addManualNoteEvidence({
      scopeId: scope.id,
      summary: 'Reviewer noted repeated issue',
    });
    const { snapshot, evidence } = service.addMetricSnapshotEvidence({
      scopeId: scope.id,
      values: { reviewComments: 2 },
      source: 'manual',
      note: 'After first check-in',
      capturedAt: 123,
    });

    const timeline = service.listTimeline(scope.id);

    expect(timeline.scope.id).toBe(scope.id);
    expect(timeline.evidence.map((item) => item.id)).toContain(note.id);
    expect(timeline.evidence.map((item) => item.id)).toContain(evidence.id);
    expect(timeline.metricSnapshots[0]?.id).toBe(snapshot.id);
    expect(service.listMetricSnapshots(scope.id)[0]?.id).toBe(snapshot.id);
  });

  it('rejects scope creation for a non-existent space', () => {
    expect(() =>
      service.createScope({
        spaceId: 'missing-space',
        kind: 'custom',
        name: 'Missing space',
        objective: 'Should fail',
      })
    ).toThrow('Space not found: missing-space');
  });

  it('rejects evidence for a non-existent scope', () => {
    expect(() =>
      service.addManualNoteEvidence({
        scopeId: 'missing-scope',
        summary: 'Should fail',
      })
    ).toThrow('EvolutionScope not found: missing-scope');
  });

  it('rejects task evidence when task has no evolution scope or goal linkage', () => {
    const task = taskRepo.createTask({
      spaceId,
      title: 'Unlinked task',
      description: 'No goal or scope',
    });

    expect(() => service.attachTaskEvidence({ taskId: task.id })).toThrow(
      `Task is not linked to an EvolutionScope or SpaceGoal: ${task.id}`
    );
  });

  it('rejects scope creation when linked goal belongs to a different space', () => {
    const otherSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/other-forge-service-test',
      slug: 'other-forge-service-test',
      name: 'Other Forge Service Test',
    }).id;
    const otherGoal = goalRepo.create({ spaceId: otherSpaceId, title: 'Other goal' });

    expect(() =>
      service.createScope({
        spaceId,
        spaceGoalId: otherGoal.id,
        kind: 'mission',
        name: 'Wrong goal space',
        objective: 'Should fail',
      })
    ).toThrow(`SpaceGoal not found in space: ${otherGoal.id}`);
  });
});

describe('extractArtifactDetail', () => {
  it('surfaces fresh shape fields (link→url, note→text, decision→recommendation)', () => {
    expect(extractArtifactDetail({ url: 'https://github.com/acme/app/pull/1' })).toBe(
      'https://github.com/acme/app/pull/1'
    );
    expect(extractArtifactDetail({ text: 'halfway done' })).toBe('halfway done');
    expect(extractArtifactDetail({ recommendation: 'approve' })).toBe('approve');
  });

  it('prefers the canonical shape field over legacy fields on the same record', () => {
    expect(extractArtifactDetail({ recommendation: 'approve', summary: 'looks good' })).toBe(
      'approve'
    );
  });

  it('falls back to legacy fields for migrated rows', () => {
    expect(extractArtifactDetail({ pr_url: 'https://github.com/acme/app/pull/9' })).toBe(
      'https://github.com/acme/app/pull/9'
    );
    expect(extractArtifactDetail({ summary: 'QA passed' })).toBe('QA passed');
    expect(extractArtifactDetail({ merge_commit: 'abc123' })).toBe('abc123');
  });

  it('returns null when no non-empty string detail is present', () => {
    expect(extractArtifactDetail({})).toBeNull();
    expect(extractArtifactDetail({ url: '   ' })).toBeNull();
    expect(extractArtifactDetail({ counts: { p0: 0 } })).toBeNull();
  });
});

describe('mergeEvolutionPolicy', () => {
  it('merges nested automation objects', () => {
    const merged = mergeEvolutionPolicy(
      { automation: { completedTaskThreshold: 5 } },
      { automation: { completedTaskAutomationEnabled: true } }
    );
    expect(merged.automation).toEqual({
      completedTaskThreshold: 5,
      completedTaskAutomationEnabled: true,
    });
  });

  it('passes through non-object automation patch so validation can reject it', () => {
    const merged = mergeEvolutionPolicy(
      { automation: { completedTaskThreshold: 5 } },
      { automation: 'bad' as never }
    );
    expect(merged.automation).toBe('bad');
  });

  it('clears the automation key on a null automation patch', () => {
    const merged = mergeEvolutionPolicy(
      { automation: { completedTaskThreshold: 5 } },
      { automation: null as never }
    );
    expect(merged.automation).toBeUndefined();
  });

  it('passes through array automation patch so validation can reject it', () => {
    const merged = mergeEvolutionPolicy(
      { automation: { completedTaskThreshold: 5 } },
      { automation: ['bad'] as never }
    );
    expect(merged.automation).toEqual(['bad']);
  });

  it('deletes top-level keys set to null in the patch', () => {
    const merged = mergeEvolutionPolicy(
      { episodeJudgeModel: 'claude-sonnet', maxActiveLessons: 3 },
      { episodeJudgeModel: null as never }
    );
    expect(merged).not.toHaveProperty('episodeJudgeModel');
    expect(merged.maxActiveLessons).toBe(3);
  });

  it('deletes top-level keys set to undefined in the patch', () => {
    const merged = mergeEvolutionPolicy(
      { episodeJudgeModel: 'claude-sonnet', maxActiveLessons: 3 },
      { episodeJudgeModel: undefined }
    );
    expect(merged).not.toHaveProperty('episodeJudgeModel');
    expect(merged.maxActiveLessons).toBe(3);
  });
});

describe('rankLessonsByTaskRelevance', () => {
  function makeLesson(overrides: Partial<EvolutionLesson> & { id?: string }): EvolutionLesson {
    const now = Date.now();
    return {
      id: overrides.id ?? `lesson-${now}-${Math.random()}`,
      scopeId: 'scope-1',
      status: 'active',
      appliesTo: [],
      rule: '',
      why: '',
      evidenceEpisodeIds: [],
      confidence: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as EvolutionLesson;
  }

  function makeTask(overrides: Partial<SpaceTask>): SpaceTask {
    const now = Date.now();
    return {
      id: 'task-1',
      spaceId: 'space-1',
      taskNumber: 1,
      title: '',
      description: '',
      status: 'open',
      priority: 'normal',
      labels: [],
      dependsOn: [],
      result: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      archivedAt: null,
      blockReason: null,
      approvalSource: null,
      approvalReason: null,
      approvedAt: null,
      pendingCheckpointType: null,
      updatedAt: now,
      ...overrides,
    } as SpaceTask;
  }

  it('returns empty array when no lessons', () => {
    const task = makeTask({ title: 'anything' });
    expect(rankLessonsByTaskRelevance([], task)).toEqual([]);
  });

  it('returns single lesson unchanged', () => {
    const lesson = makeLesson({ rule: 'Only lesson' });
    const task = makeTask({ title: 'anything' });
    expect(rankLessonsByTaskRelevance([lesson], task)).toEqual([lesson]);
  });

  it('ranks tag-matching lessons above non-matching', () => {
    const task = makeTask({ title: 'Gate fix', labels: ['workflow'] });
    const matching = makeLesson({ rule: 'Match', appliesTo: ['workflow'] });
    const nonMatching = makeLesson({ rule: 'No match', appliesTo: ['tool'] });
    const ranked = rankLessonsByTaskRelevance([nonMatching, matching], task);
    expect(ranked[0].id).toBe(matching.id);
    expect(ranked[1].id).toBe(nonMatching.id);
  });

  it('ranks keyword-matching lessons above non-matching', () => {
    const task = makeTask({ title: 'ContextPanel switch case bug' });
    const matching = makeLesson({ rule: 'Preserve switch cases in ContextPanel' });
    const nonMatching = makeLesson({ rule: 'Use GitHub CLI for PRs' });
    const ranked = rankLessonsByTaskRelevance([nonMatching, matching], task);
    expect(ranked[0].id).toBe(matching.id);
    expect(ranked[1].id).toBe(nonMatching.id);
  });

  it('uses recency as tiebreaker when scores are equal', () => {
    const now = Date.now();
    const older = makeLesson({ rule: 'Older', updatedAt: now - 10_000 });
    const newer = makeLesson({ rule: 'Newer', updatedAt: now });
    const task = makeTask({ title: 'Unrelated' });
    const ranked = rankLessonsByTaskRelevance([older, newer], task);
    expect(ranked[0].id).toBe(newer.id);
    expect(ranked[1].id).toBe(older.id);
  });

  it('boosts higher-confidence lessons when other signals are equal', () => {
    const lowConfidence = makeLesson({ rule: 'Low', confidence: 0.1 });
    const highConfidence = makeLesson({ rule: 'High', confidence: 0.9 });
    const task = makeTask({ title: 'Unrelated' });
    const ranked = rankLessonsByTaskRelevance([lowConfidence, highConfidence], task);
    expect(ranked[0].id).toBe(highConfidence.id);
    expect(ranked[1].id).toBe(lowConfidence.id);
  });
});
