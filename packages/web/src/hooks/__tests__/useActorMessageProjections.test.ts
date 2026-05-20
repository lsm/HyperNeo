import { act, renderHook } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockOnEvent, mockGetHub, mockIsConnected } = vi.hoisted(() => ({
	mockRequest: vi.fn().mockResolvedValue(undefined),
	mockOnEvent: vi.fn<(method: string, handler: (event: unknown) => void) => () => void>(
		() => () => {}
	),
	mockGetHub: vi.fn(),
	mockIsConnected: { value: true },
}));

vi.mock('../useMessageHub', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		getHub: mockGetHub,
		get isConnected() {
			return mockIsConnected.value;
		},
	}),
}));

type EventHandler = (event: unknown) => void;
let eventHandlers: Record<string, EventHandler[]> = {};

function fireEvent(method: string, payload: unknown): void {
	(eventHandlers[method] ?? []).forEach((handler) => handler(payload));
}

function subscribeCalls() {
	return mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.subscribe');
}

import { useActorMessageProjections } from '../useActorMessageProjections';

describe('useActorMessageProjections', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockGetHub.mockReset();
		mockRequest.mockResolvedValue(undefined);
		mockGetHub.mockReturnValue({ request: mockRequest, onConnection: vi.fn(() => () => {}) });
		mockIsConnected.value = true;
		eventHandlers = {};
		mockOnEvent.mockImplementation((method: string, handler: EventHandler) => {
			if (!eventHandlers[method]) eventHandlers[method] = [];
			eventHandlers[method].push(handler);
			return () => {
				eventHandlers[method] = (eventHandlers[method] ?? []).filter((h) => h !== handler);
			};
		});
	});

	it('subscribes to task timeline projection', () => {
		renderHook(() => useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' }));

		expect(subscribeCalls()).toHaveLength(1);
		expect(subscribeCalls()[0][1]).toMatchObject({
			queryName: 'actorMessages.byTask',
			params: ['task-1'],
		});
	});

	it('subscribes to workflow log projection with each SQL parameter', () => {
		renderHook(() => useActorMessageProjections({ scope: 'workflow_log', workflowRunId: 'run-1' }));

		expect(subscribeCalls()).toHaveLength(1);
		expect(subscribeCalls()[0][1]).toMatchObject({
			queryName: 'actorMessages.byWorkflowRun',
			params: ['run-1', 'run-1', 'run-1'],
		});
	});

	it('merges delta rows and keeps chronological order', () => {
		const { result } = renderHook(() =>
			useActorMessageProjections({ scope: 'task_timeline', taskId: 'task-1' })
		);
		const subId = subscribeCalls()[0][1].subscriptionId;

		act(() => {
			fireEvent('liveQuery.snapshot', {
				subscriptionId: subId,
				rows: [
					{
						id: 'b',
						scope: 'task_timeline',
						eventKind: 'answer',
						from: { kind: 'worker', label: 'Coder' },
						title: 'Answer',
						summary: 'Done',
						createdAt: 20,
					},
				],
				version: 1,
			});
			fireEvent('liveQuery.delta', {
				subscriptionId: subId,
				added: [
					{
						id: 'a',
						scope: 'task_timeline',
						eventKind: 'question',
						from: { kind: 'human', label: 'Human' },
						title: 'Question',
						summary: 'Start?',
						createdAt: 10,
					},
				],
			});
		});

		expect(result.current.rows.map((row) => row.id)).toEqual(['a', 'b']);
		expect(result.current.isLoading).toBe(false);
	});
});
