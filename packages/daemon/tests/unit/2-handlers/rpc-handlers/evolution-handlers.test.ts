import { describe, expect, test } from 'bun:test';
import { setupEvolutionHandlers } from '../../../../src/lib/rpc-handlers/evolution-handlers';

function createMessageHubStub() {
	const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
	return {
		messageHub: {
			onRequest(name: string, handler: (payload: unknown) => Promise<unknown>) {
				handlers.set(name, handler);
			},
		},
		handlers,
	};
}

describe('evolution RPC handlers', () => {
	test('wires all handler endpoints and extracts payloads', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		const calls: Array<[string, unknown]> = [];
		setupEvolutionHandlers(
			messageHub as never,
			{
				createScope: (params: unknown) => {
					calls.push(['createScope', params]);
					return { id: 'scope-1' };
				},
				createScopeFromGoal: (params: unknown) => {
					calls.push(['createScopeFromGoal', params]);
					return { id: 'scope-from-goal' };
				},
				getScope: (id: string) => {
					calls.push(['getScope', id]);
					return { id };
				},
				listScopes: (params: unknown) => {
					calls.push(['listScopes', params]);
					return [{ id: 'scope-listed' }];
				},
				updateScope: (id: string, params: unknown) => {
					calls.push(['updateScope', { id, params }]);
					return { id, ...(params as object) };
				},
				resolveScopeForGoal: (params: unknown) => {
					calls.push(['resolveScopeForGoal', params]);
					return { id: 'scope-resolved' };
				},
				createEvidence: (params: unknown) => {
					calls.push(['createEvidence', params]);
					return { id: 'evidence-created' };
				},
				attachTaskEvidence: (params: unknown) => {
					calls.push(['attachTaskEvidence', params]);
					return { id: 'evidence-task' };
				},
				attachWorkflowRunEvidence: (params: unknown) => {
					calls.push(['attachWorkflowRunEvidence', params]);
					return { id: 'evidence-run' };
				},
				addManualNoteEvidence: (params: unknown) => {
					calls.push(['addManualNoteEvidence', params]);
					return { id: 'evidence-note' };
				},
				addMetricSnapshotEvidence: (params: unknown) => {
					calls.push(['addMetricSnapshotEvidence', params]);
					return { snapshot: { id: 'snapshot-1' }, evidence: { id: 'evidence-snapshot' } };
				},
				listEvidence: (scopeId: string) => {
					calls.push(['listEvidence', scopeId]);
					return [{ id: 'evidence-listed' }];
				},
				listTimeline: (scopeId: string) => {
					calls.push(['listTimeline', scopeId]);
					return { scope: { id: scopeId }, evidence: [], metricSnapshots: [] };
				},
				listMetricSnapshots: (scopeId: string) => {
					calls.push(['listMetricSnapshots', scopeId]);
					return [{ id: 'snapshot-listed' }];
				},
			} as never
		);

		expect(
			await handlers.get('evolution.scope.create')?.({ params: { spaceId: 'space-1' } })
		).toEqual({
			scope: { id: 'scope-1' },
		});
		expect(
			await handlers.get('evolution.scope.createFromGoal')?.({ spaceGoalId: 'goal-1' })
		).toEqual({
			scope: { id: 'scope-from-goal' },
		});
		expect(await handlers.get('evolution.scope.get')?.({ id: 'scope-1' })).toEqual({
			scope: { id: 'scope-1' },
		});
		expect(await handlers.get('evolution.scope.list')?.({ spaceId: 'space-1' })).toEqual({
			scopes: [{ id: 'scope-listed' }],
		});
		expect(
			await handlers.get('evolution.scope.update')?.({ id: 'scope-1', params: { name: 'New' } })
		).toEqual({ scope: { id: 'scope-1', name: 'New' } });
		expect(
			await handlers.get('evolution.scope.resolveForGoal')?.({ spaceGoalId: 'goal-1' })
		).toEqual({
			scope: { id: 'scope-resolved' },
		});
		expect(
			await handlers.get('evolution.evidence.create')?.({ params: { scopeId: 'scope-1' } })
		).toEqual({
			evidence: { id: 'evidence-created' },
		});
		expect(await handlers.get('evolution.evidence.attachTask')?.({ taskId: 'task-1' })).toEqual({
			evidence: { id: 'evidence-task' },
		});
		expect(
			await handlers.get('evolution.evidence.attachWorkflowRun')?.({ workflowRunId: 'run-1' })
		).toEqual({ evidence: { id: 'evidence-run' } });
		expect(
			await handlers.get('evolution.evidence.addManualNote')?.({
				scopeId: 'scope-1',
				summary: 'Note',
			})
		).toEqual({ evidence: { id: 'evidence-note' } });
		expect(
			await handlers.get('evolution.evidence.addMetricSnapshot')?.({
				scopeId: 'scope-1',
				values: { count: 1 },
				source: 'manual',
			})
		).toEqual({ snapshot: { id: 'snapshot-1' }, evidence: { id: 'evidence-snapshot' } });
		expect(await handlers.get('evolution.evidence.list')?.({ scopeId: 'scope-1' })).toEqual({
			evidence: [{ id: 'evidence-listed' }],
		});
		expect(await handlers.get('evolution.timeline.list')?.({ scopeId: 'scope-1' })).toEqual({
			scope: { id: 'scope-1' },
			evidence: [],
			metricSnapshots: [],
		});
		expect(
			await handlers.get('evolution.metricSnapshot.create')?.({
				params: { scopeId: 'scope-1', values: { count: 1 }, source: 'manual' },
			})
		).toEqual({ snapshot: { id: 'snapshot-1' }, evidence: { id: 'evidence-snapshot' } });
		expect(await handlers.get('evolution.metricSnapshot.list')?.({ scopeId: 'scope-1' })).toEqual({
			snapshots: [{ id: 'snapshot-listed' }],
		});

		expect(calls).toContainEqual(['createScopeFromGoal', { spaceGoalId: 'goal-1' }]);
		expect(calls).toContainEqual(['updateScope', { id: 'scope-1', params: { name: 'New' } }]);
		expect(calls).toContainEqual(['listMetricSnapshots', 'scope-1']);
	});

	test('rejects non-object payloads', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		setupEvolutionHandlers(messageHub as never, {} as never);

		await expect(handlers.get('evolution.scope.create')?.(null)).rejects.toThrow(
			'request payload must be an object'
		);
	});

	test('requires scopeId for list endpoints', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		setupEvolutionHandlers(messageHub as never, {} as never);

		await expect(handlers.get('evolution.timeline.list')?.({})).rejects.toThrow(
			'scopeId is required'
		);
		await expect(handlers.get('evolution.metricSnapshot.list')?.({})).rejects.toThrow(
			'scopeId is required'
		);
	});
});
