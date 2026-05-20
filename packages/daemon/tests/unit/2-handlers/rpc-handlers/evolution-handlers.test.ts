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
	test('creates scopes through service', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		const calls: unknown[] = [];
		setupEvolutionHandlers(
			messageHub as never,
			{
				createScope: (params: unknown) => {
					calls.push(params);
					return { id: 'scope-1' };
				},
			} as never
		);

		const response = await handlers.get('evolution.scope.create')?.({
			params: {
				spaceId: 'space-1',
				kind: 'custom',
				name: 'Scope',
				objective: 'Learn',
			},
		});

		expect(calls[0]).toMatchObject({ spaceId: 'space-1', kind: 'custom' });
		expect(response).toEqual({ scope: { id: 'scope-1' } });
	});

	test('rejects non-object payloads', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		setupEvolutionHandlers(messageHub as never, {} as never);

		await expect(handlers.get('evolution.scope.create')?.(null)).rejects.toThrow(
			'request payload must be an object'
		);
	});

	test('attaches task evidence by forwarding payload', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		setupEvolutionHandlers(
			messageHub as never,
			{
				attachTaskEvidence: (params: unknown) => ({ id: 'evidence-1', ...params }),
			} as never
		);

		const response = await handlers.get('evolution.evidence.attachTask')?.({
			taskId: 'task-1',
			summary: 'Done',
		});

		expect(response).toEqual({
			evidence: { id: 'evidence-1', taskId: 'task-1', summary: 'Done' },
		});
	});

	test('lists timeline with required scopeId', async () => {
		const { messageHub, handlers } = createMessageHubStub();
		setupEvolutionHandlers(
			messageHub as never,
			{
				listTimeline: (scopeId: string) => ({
					scope: { id: scopeId },
					evidence: [],
					metricSnapshots: [],
				}),
			} as never
		);

		expect(await handlers.get('evolution.timeline.list')?.({ scopeId: 'scope-1' })).toEqual({
			scope: { id: 'scope-1' },
			evidence: [],
			metricSnapshots: [],
		});
		await expect(handlers.get('evolution.timeline.list')?.({})).rejects.toThrow(
			'scopeId is required'
		);
	});
});
