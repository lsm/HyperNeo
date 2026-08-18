import type {
  EvolutionScope,
  EvolutionEpisodeCreateFromEvidenceRequest,
  EvolutionEpisodeCreateRequest,
  EvolutionEpisodeCreateResponse,
  EvolutionEpisodeListRequest,
  EvolutionEpisodeListResponse,
  EvolutionEpisodeReviewBundleResponse,
  EvolutionEpisodeUpdateRequest,
  EvolutionEpisodeUpdateResponse,
  EvolutionEvidenceCreateRequest,
  EvolutionEvidenceCreateResponse,
  EvolutionEvidenceListRequest,
  EvolutionEvidenceListResponse,
  EvolutionLessonListRequest,
  EvolutionLessonListResponse,
  EvolutionLessonUpdateRequest,
  EvolutionLessonUpdateResponse,
  EvolutionMetricSnapshotCreateRequest,
  EvolutionMetricSnapshotCreateResponse,
  EvolutionMetricSnapshotListRequest,
  EvolutionMetricSnapshotListResponse,
  EvolutionScopeCreateRequest,
  EvolutionScopeCreateResponse,
  EvolutionScopeGetRequest,
  EvolutionScopeGetResponse,
  EvolutionScopeListRequest,
  EvolutionScopeListResponse,
  EvolutionScopeUpdateRequest,
  EvolutionScopeUpdateResponse,
  EvolutionTaskLessonSelectRequest,
  EvolutionTaskLessonSelectResponse,
  EvolutionTaskProposalCreateTaskRequest,
  EvolutionTaskProposalCreateTaskResponse,
  EvolutionTaskProposalListRequest,
  EvolutionTaskProposalListResponse,
  EvolutionTaskProposalUpdateRequest,
  EvolutionTaskProposalUpdateResponse,
  EvolutionRollupApplyRequest,
  EvolutionRollupApplyResponse,
  MessageHub,
} from '@hyperneo/shared';
import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import type { EvolutionEpisodeService } from '../space/evolution-episode-service';
import type {
  AddManualNoteEvidenceParams,
  AddMetricSnapshotEvidenceParams,
  AttachTaskEvidenceParams,
  AttachWorkflowRunEvidenceParams,
  CreateScopeFromGoalParams,
  EvolutionScopeService,
  ResolveScopeForGoalParams,
} from '../space/evolution-scope-service';

interface RecordPayload {
  [key: string]: unknown;
}

export interface EvolutionHandlerHooks {
  beforeScopeCreate?: (
    params: EvolutionScopeCreateRequest['params'] | EvolutionScopeUpdateRequest['params']
  ) => void;
  beforeScopeUpdate?: (
    existing: EvolutionScope,
    params: EvolutionScopeUpdateRequest['params']
  ) => void;
  beforeScopeSave?: (
    params: EvolutionScopeCreateRequest['params'] | EvolutionScopeUpdateRequest['params']
  ) => void;
  onScopeSaved?: (scope: EvolutionScope) => void;
}

export function setupEvolutionHandlers(
  messageHub: MessageHub,
  service: EvolutionScopeService,
  episodeService?: EvolutionEpisodeService,
  hooks: EvolutionHandlerHooks = {},
  db?: BunDatabase
): void {
  messageHub.onRequest<EvolutionScopeCreateRequest, EvolutionScopeCreateResponse>(
    'evolution.scope.create',
    async (data) => {
      const payload = readRecord(data);
      const params = readRecord(payload.params) as unknown as EvolutionScopeCreateRequest['params'];
      hooks.beforeScopeCreate?.(params);
      hooks.beforeScopeSave?.(params);
      const run = () => {
        const scope = service.createScope(params);
        hooks.onScopeSaved?.(scope);
        return scope;
      };
      const scope = db ? db.transaction(run)() : run();
      return { scope };
    }
  );

  messageHub.onRequest<CreateScopeFromGoalParams, EvolutionScopeCreateResponse>(
    'evolution.scope.createFromGoal',
    async (data) => {
      const payload = readRecord(data) as unknown as CreateScopeFromGoalParams;
      hooks.beforeScopeCreate?.({ policy: payload.policy });
      hooks.beforeScopeSave?.({ policy: payload.policy });
      const run = () => {
        const scope = service.createScopeFromGoal(payload);
        hooks.onScopeSaved?.(scope);
        return scope;
      };
      const scope = db ? db.transaction(run)() : run();
      return { scope };
    }
  );

  messageHub.onRequest<EvolutionScopeGetRequest, EvolutionScopeGetResponse>(
    'evolution.scope.get',
    async (data) => ({ scope: service.getScope(readRequiredString(data, 'id')) })
  );

  messageHub.onRequest<EvolutionScopeListRequest, EvolutionScopeListResponse>(
    'evolution.scope.list',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionScopeListRequest;
      return { scopes: service.listScopes(payload) };
    }
  );

  messageHub.onRequest<EvolutionScopeUpdateRequest, EvolutionScopeUpdateResponse>(
    'evolution.scope.update',
    async (data) => {
      const payload = readRecord(data);
      const id = readRequiredString(payload, 'id');
      const params = readRecord(payload.params) as EvolutionScopeUpdateRequest['params'];
      hooks.beforeScopeSave?.(params);
      const existing = service.getScope(id);
      if (existing) hooks.beforeScopeUpdate?.(existing, params);
      const scope = service.updateScope(id, params);
      if (scope) hooks.onScopeSaved?.(scope);
      return { scope };
    }
  );

  messageHub.onRequest<ResolveScopeForGoalParams, EvolutionScopeGetResponse>(
    'evolution.scope.resolveForGoal',
    async (data) => {
      const payload = readRecord(data) as unknown as ResolveScopeForGoalParams;
      return { scope: service.resolveScopeForGoal(payload) };
    }
  );

  messageHub.onRequest<EvolutionEvidenceCreateRequest, EvolutionEvidenceCreateResponse>(
    'evolution.evidence.create',
    async (data) => {
      const payload = readRecord(data);
      const params = readRecord(
        payload.params
      ) as unknown as EvolutionEvidenceCreateRequest['params'];
      return { evidence: service.createEvidence(params) };
    }
  );

  messageHub.onRequest<AttachTaskEvidenceParams, EvolutionEvidenceCreateResponse>(
    'evolution.evidence.attachTask',
    async (data) => {
      const payload = readRecord(data) as unknown as AttachTaskEvidenceParams;
      return { evidence: service.attachTaskEvidence(payload) };
    }
  );

  messageHub.onRequest<AttachWorkflowRunEvidenceParams, EvolutionEvidenceCreateResponse>(
    'evolution.evidence.attachWorkflowRun',
    async (data) => {
      const payload = readRecord(data) as unknown as AttachWorkflowRunEvidenceParams;
      return { evidence: service.attachWorkflowRunEvidence(payload) };
    }
  );

  messageHub.onRequest<AddManualNoteEvidenceParams, EvolutionEvidenceCreateResponse>(
    'evolution.evidence.addManualNote',
    async (data) => {
      const payload = readRecord(data) as unknown as AddManualNoteEvidenceParams;
      return { evidence: service.addManualNoteEvidence(payload) };
    }
  );

  messageHub.onRequest<
    AddMetricSnapshotEvidenceParams,
    EvolutionMetricSnapshotCreateResponse & EvolutionEvidenceCreateResponse
  >('evolution.evidence.addMetricSnapshot', async (data) => {
    const payload = readRecord(data) as unknown as AddMetricSnapshotEvidenceParams;
    return service.addMetricSnapshotEvidence(payload);
  });

  messageHub.onRequest<EvolutionEvidenceListRequest, EvolutionEvidenceListResponse>(
    'evolution.evidence.list',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionEvidenceListRequest;
      return service.listEvidence(readRequiredString(payload, 'scopeId'), {
        includePreflightContext: payload.includePreflightContext === true,
        limit: payload.limit,
        offset: payload.offset,
      });
    }
  );

  messageHub.onRequest<
    EvolutionEvidenceListRequest,
    ReturnType<EvolutionScopeService['listTimeline']>
  >('evolution.timeline.list', async (data) =>
    service.listTimeline(readRequiredString(data, 'scopeId'))
  );

  messageHub.onRequest<
    EvolutionMetricSnapshotCreateRequest,
    EvolutionMetricSnapshotCreateResponse & EvolutionEvidenceCreateResponse
  >('evolution.metricSnapshot.create', async (data) => {
    const payload = readRecord(data);
    const params = readRecord(
      payload.params
    ) as unknown as EvolutionMetricSnapshotCreateRequest['params'];
    return service.addMetricSnapshotEvidence({
      scopeId: params.scopeId,
      values: params.values,
      source: params.source,
      note: params.note,
      capturedAt: params.capturedAt,
    });
  });

  messageHub.onRequest<EvolutionMetricSnapshotListRequest, EvolutionMetricSnapshotListResponse>(
    'evolution.metricSnapshot.list',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionMetricSnapshotListRequest;
      return {
        snapshots: service.listMetricSnapshots(readRequiredString(payload, 'scopeId'), {
          limit: payload.limit,
          offset: payload.offset,
        }),
      };
    }
  );

  messageHub.onRequest<EvolutionTaskLessonSelectRequest, EvolutionTaskLessonSelectResponse>(
    'evolution.task.lessons.select',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionTaskLessonSelectRequest;
      return { lessons: service.selectActiveLessonsForTask(payload) };
    }
  );

  if (!episodeService) return;

  messageHub.onRequest<EvolutionEpisodeCreateRequest, EvolutionEpisodeCreateResponse>(
    'evolution.episode.create',
    async (data) => {
      const payload = readRecord(data);
      const params = readRecord(
        payload.params
      ) as unknown as EvolutionEpisodeCreateRequest['params'];
      return { episode: episodeService.createEpisode(params) };
    }
  );

  messageHub.onRequest<EvolutionEpisodeCreateFromEvidenceRequest, EvolutionEpisodeCreateResponse>(
    'evolution.episode.createFromEvidence',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionEpisodeCreateFromEvidenceRequest;
      return episodeService.createFromEvidence(payload);
    }
  );

  messageHub.onRequest<EvolutionEpisodeListRequest, EvolutionEpisodeListResponse>(
    'evolution.episode.list',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionEpisodeListRequest;
      return {
        episodes: episodeService.listEpisodes(readRequiredString(payload, 'scopeId'), {
          limit: payload.limit,
          offset: payload.offset,
        }),
      };
    }
  );

  messageHub.onRequest<EvolutionEpisodeListRequest, EvolutionEpisodeReviewBundleResponse>(
    'evolution.review.get',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionEpisodeListRequest;
      return episodeService.listReviewBundle(readRequiredString(payload, 'scopeId'), {
        limit: payload.limit,
        offset: payload.offset,
      });
    }
  );

  messageHub.onRequest<EvolutionEpisodeUpdateRequest, EvolutionEpisodeUpdateResponse>(
    'evolution.episode.update',
    async (data) => {
      const payload = readRecord(data);
      const id = readRequiredString(payload, 'id');
      const params = readRecord(payload.params) as EvolutionEpisodeUpdateRequest['params'];
      return { episode: episodeService.updateEpisode(id, params) };
    }
  );

  messageHub.onRequest<EvolutionLessonListRequest, EvolutionLessonListResponse>(
    'evolution.lesson.list',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionLessonListRequest;
      return {
        lessons: episodeService.listLessons(payload.scopeId, payload.status, {
          limit: payload.limit,
          offset: payload.offset,
        }),
      };
    }
  );

  messageHub.onRequest<EvolutionLessonUpdateRequest, EvolutionLessonUpdateResponse>(
    'evolution.lesson.update',
    async (data) => {
      const payload = readRecord(data);
      const id = readRequiredString(payload, 'id');
      const params = readRecord(payload.params) as EvolutionLessonUpdateRequest['params'];
      return { lesson: episodeService.updateLesson(id, params) };
    }
  );

  messageHub.onRequest<EvolutionTaskProposalListRequest, EvolutionTaskProposalListResponse>(
    'evolution.taskProposal.list',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionTaskProposalListRequest;
      return {
        proposals: episodeService.listTaskProposals(payload.scopeId, payload.status, {
          limit: payload.limit,
          offset: payload.offset,
        }),
      };
    }
  );

  messageHub.onRequest<EvolutionTaskProposalUpdateRequest, EvolutionTaskProposalUpdateResponse>(
    'evolution.taskProposal.update',
    async (data) => {
      const payload = readRecord(data);
      const id = readRequiredString(payload, 'id');
      const params = readRecord(payload.params) as EvolutionTaskProposalUpdateRequest['params'];
      return { proposal: episodeService.updateTaskProposal(id, params) };
    }
  );

  messageHub.onRequest<
    EvolutionTaskProposalCreateTaskRequest,
    EvolutionTaskProposalCreateTaskResponse
  >('evolution.taskProposal.createTask', async (data) => {
    const payload = readRecord(data);
    const id = readRequiredString(payload, 'id');
    const params = payload.params === undefined ? {} : readRecord(payload.params);
    return episodeService.createTaskFromProposal(
      id,
      params as EvolutionTaskProposalCreateTaskRequest['params']
    );
  });

  messageHub.onRequest<EvolutionRollupApplyRequest, EvolutionRollupApplyResponse>(
    'evolution.rollup.apply',
    async (data) => {
      const payload = readRecord(data) as unknown as EvolutionRollupApplyRequest;
      return episodeService.applyRollupGoalUpdate(payload);
    }
  );
}

function readRecord(value: unknown): RecordPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request payload must be an object');
  }
  return value as RecordPayload;
}

function readRequiredString(value: unknown, key: string): string {
  const record = readRecord(value);
  const field = record[key];
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return field;
}
