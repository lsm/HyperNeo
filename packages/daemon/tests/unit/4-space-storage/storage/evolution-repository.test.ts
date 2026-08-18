import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('EvolutionRepository', () => {
  let db: Database;
  let repo: EvolutionRepository;
  let spaceTaskRepo: SpaceTaskRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as never);
    repo = new EvolutionRepository(db as never);
    spaceTaskRepo = new SpaceTaskRepository(db as never);

    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/forge-test',
      slug: 'forge-test',
      name: 'Forge Test',
    });
    spaceId = space.id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates, lists, and updates scopes linked to SpaceGoal IDs', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_goals (id, space_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run('goal-1', spaceId, 'Recurring Forge goal', now, now);

    const scope = repo.createScope({
      spaceId,
      spaceGoalId: 'goal-1',
      kind: 'mission',
      name: 'Improve coding workflow',
      objective: 'Reduce review churn',
      metricDefinitions: [
        {
          key: 'review_comments',
          label: 'Review comments',
          direction: 'decrease',
          targetValue: 3,
        },
      ],
      policy: { maxActiveLessons: 3 },
    });

    expect(scope.spaceId).toBe(spaceId);
    expect(scope.spaceGoalId).toBe('goal-1');
    expect(scope.metricDefinitions[0]?.key).toBe('review_comments');
    expect(scope.policy.maxActiveLessons).toBe(3);
    expect(repo.listScopes({ spaceId, spaceGoalId: 'goal-1' })).toHaveLength(1);
    expect(repo.listScopes({ spaceId, kind: 'mission' })[0]?.id).toBe(scope.id);

    const updated = repo.updateScope(scope.id, {
      spaceGoalId: null,
      objective: 'Reduce review churn and retries',
      policy: { ...scope.policy, episodeJudgeModel: 'claude-sonnet-4-5' },
    });

    expect(updated?.spaceGoalId).toBeNull();
    expect(updated?.objective).toBe('Reduce review churn and retries');
    expect(updated?.policy).toMatchObject({
      episodeJudgeModel: 'claude-sonnet-4-5',
      maxActiveLessons: 3,
    });
    expect(repo.listScopes({ spaceId, spaceGoalId: null })[0]?.id).toBe(scope.id);
  });

  it('stores evidence, episodes, lessons, proposals, and metric snapshots for a scope', () => {
    const scope = repo.createScope({
      spaceId,
      kind: 'workflow',
      name: 'Coding loop',
      objective: 'Learn from scoped tasks',
    });

    const task = spaceTaskRepo.createTask({
      spaceId,
      title: 'Implement Forge storage',
      description: 'Add storage contracts',
      evolutionScopeId: scope.id,
    });
    expect(task.evolutionScopeId).toBe(scope.id);

    const evidence = repo.createEvidence({
      scopeId: scope.id,
      kind: 'task_result',
      sourceId: task.id,
      summary: 'Task completed with reviewer feedback',
      metadata: { taskNumber: task.taskNumber },
      createdAt: 100,
    });

    const episode = repo.createEpisode({
      scopeId: scope.id,
      title: 'Storage foundation',
      timeWindow: { start: 100, end: 200 },
      evidenceIds: [evidence.id],
      outcomeSummary: 'Repository contract landed',
      findings: [
        {
          domain: 'workflow',
          kind: 'optimization',
          impact: 'medium',
          confidence: 0.8,
          evidence: [evidence.id],
          proposedAction: 'Keep storage tests focused',
        },
      ],
    });

    const lesson = repo.createLesson({
      scopeId: scope.id,
      status: 'active',
      appliesTo: ['storage'],
      rule: 'Add repository tests with every storage contract',
      why: 'Catches schema drift',
      evidenceEpisodeIds: [episode.id],
      confidence: 0.75,
    });

    const proposal = repo.createTaskProposal({
      scopeId: scope.id,
      title: 'Inject active lessons',
      description: 'Use active lessons in future task messages',
      reason: 'Close scoped learning loop',
      priority: 'high',
      evidenceEpisodeIds: [episode.id],
    });

    const snapshot = repo.createMetricSnapshot({
      scopeId: scope.id,
      capturedAt: 150,
      values: { reviewComments: 2, accepted: true },
      source: 'manual',
      note: 'Baseline after first MVP slice',
    });

    expect(repo.listEvidence(scope.id)[0]).toMatchObject({ id: evidence.id, sourceId: task.id });
    expect(repo.listEpisodes(scope.id)[0]).toMatchObject({
      id: episode.id,
      evidenceIds: [evidence.id],
    });
    expect(repo.listLessons(scope.id, 'active')[0]).toMatchObject({
      id: lesson.id,
      appliesTo: ['storage'],
    });
    expect(repo.listTaskProposals(scope.id, 'proposed')[0]).toMatchObject({
      id: proposal.id,
      priority: 'high',
    });
    expect(repo.listMetricSnapshots(scope.id)[0]).toMatchObject({
      id: snapshot.id,
      values: { reviewComments: 2, accepted: true },
    });
  });

  it('paginates list* methods with limit/offset and stays unbounded when omitted', () => {
    const scope = repo.createScope({
      spaceId,
      kind: 'workflow',
      name: 'Pagination scope',
      objective: 'Bound the list queries',
    });
    for (let index = 0; index < 5; index++) {
      repo.createEvidence({
        scopeId: scope.id,
        kind: 'manual_note',
        summary: `note ${index}`,
        createdAt: 100 + index,
      });
    }
    for (let index = 0; index < 5; index++) {
      repo.createEpisode({ scopeId: scope.id, title: `episode ${index}` });
      repo.createLesson({ scopeId: scope.id, rule: `rule ${index}`, why: 'because' });
      repo.createTaskProposal({
        scopeId: scope.id,
        title: `proposal ${index}`,
        description: 'd',
        reason: 'r',
      });
      repo.createMetricSnapshot({
        scopeId: scope.id,
        capturedAt: 100 + index,
        values: { n: index },
        source: 'manual',
      });
    }

    expect(repo.listEvidence(scope.id)).toHaveLength(5);
    expect(repo.listEpisodes(scope.id)).toHaveLength(5);
    expect(repo.listLessons(scope.id)).toHaveLength(5);
    expect(repo.listTaskProposals(scope.id)).toHaveLength(5);
    expect(repo.listMetricSnapshots(scope.id)).toHaveLength(5);

    expect(repo.listEvidence(scope.id, { limit: 2 })).toHaveLength(2);
    expect(repo.listEvidence(scope.id, { limit: 2 })[0]?.summary).toBe('note 4');
    expect(repo.listEvidence(scope.id, { limit: 2, offset: 2 })[0]?.summary).toBe('note 2');
    expect(repo.listEpisodes(scope.id, { limit: 2, offset: 2 })).toHaveLength(2);
    expect(repo.listLessons(scope.id, undefined, { limit: 2 })).toHaveLength(2);
    expect(repo.listTaskProposals(scope.id, undefined, { limit: 1 })).toHaveLength(1);
    expect(repo.listMetricSnapshots(scope.id, { limit: 3, offset: 4 })).toHaveLength(1);

    expect(repo.listEvidence(scope.id, { limit: 100 })).toHaveLength(5);
    expect(repo.listEvidence(scope.id, { limit: 2, offset: 100 })).toHaveLength(0);

    expect(repo.listEvidence(scope.id, { limit: 0 })).toHaveLength(5);
    expect(repo.listEvidence(scope.id, { limit: -3 })).toHaveLength(5);
    expect(repo.listEvidence(scope.id, { limit: Number.NaN })).toHaveLength(5);

    expect(() => repo.listEvidence(scope.id, { limit: 10_000 })).not.toThrow();

    expect(repo.listScopes({ spaceId, limit: 1 })).toHaveLength(1);
  });

  it('updates episode, lesson, and proposal lifecycle state', () => {
    const scope = repo.createScope({
      spaceId,
      kind: 'campaign',
      name: 'Scoped learning',
      objective: 'Track lessons',
    });
    const episode = repo.createEpisode({ scopeId: scope.id, title: 'Draft episode' });
    const lesson = repo.createLesson({ scopeId: scope.id, rule: 'Do X', why: 'Because Y' });
    const proposal = repo.createTaskProposal({
      scopeId: scope.id,
      title: 'Follow-up task',
      description: 'Do follow-up work',
      reason: 'Episode found gap',
    });

    expect(repo.updateEpisode(episode.id, { status: 'accepted' })?.status).toBe('accepted');
    expect(repo.updateLesson(lesson.id, { status: 'dismissed', confidence: 0.2 })?.status).toBe(
      'dismissed'
    );
    const createdTask = spaceTaskRepo.createTask({
      spaceId,
      title: 'Created follow-up task',
      description: 'Task materialized from proposal',
    });
    expect(
      repo.updateTaskProposal(proposal.id, { status: 'created', createdTaskId: createdTask.id })
        ?.createdTaskId
    ).toBe(createdTask.id);
  });
});
