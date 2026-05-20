import type {
	EvolutionEvidenceCreateRequest,
	EvolutionEvidenceCreateResponse,
	EvolutionEvidenceListRequest,
	EvolutionEvidenceListResponse,
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
	MessageHub,
} from '@neokai/shared';
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

export function setupEvolutionHandlers(
	messageHub: MessageHub,
	service: EvolutionScopeService
): void {
	messageHub.onRequest<EvolutionScopeCreateRequest, EvolutionScopeCreateResponse>(
		'evolution.scope.create',
		async (data) => {
			const payload = readRecord(data);
			const params = readRecord(payload.params) as unknown as EvolutionScopeCreateRequest['params'];
			return { scope: service.createScope(params) };
		}
	);

	messageHub.onRequest<CreateScopeFromGoalParams, EvolutionScopeCreateResponse>(
		'evolution.scope.createFromGoal',
		async (data) => {
			const payload = readRecord(data) as unknown as CreateScopeFromGoalParams;
			return { scope: service.createScopeFromGoal(payload) };
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
			return { scope: service.updateScope(id, params) };
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
		async (data) => ({ evidence: service.listEvidence(readRequiredString(data, 'scopeId')) })
	);

	messageHub.onRequest<
		EvolutionEvidenceListRequest,
		ReturnType<EvolutionScopeService['listTimeline']>
	>('evolution.timeline.list', async (data) =>
		service.listTimeline(readRequiredString(data, 'scopeId'))
	);

	messageHub.onRequest<EvolutionMetricSnapshotCreateRequest, EvolutionMetricSnapshotCreateResponse>(
		'evolution.metricSnapshot.create',
		async (data) => {
			const payload = readRecord(data);
			const params = readRecord(
				payload.params
			) as unknown as EvolutionMetricSnapshotCreateRequest['params'];
			const { snapshot } = service.addMetricSnapshotEvidence({
				scopeId: params.scopeId,
				values: params.values,
				source: params.source,
				note: params.note,
				capturedAt: params.capturedAt,
			});
			return { snapshot };
		}
	);

	messageHub.onRequest<EvolutionMetricSnapshotListRequest, EvolutionMetricSnapshotListResponse>(
		'evolution.metricSnapshot.list',
		async (data) => ({
			snapshots: service.listTimeline(readRequiredString(data, 'scopeId')).metricSnapshots,
		})
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
