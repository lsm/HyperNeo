import { render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

const mockUseActorMessageProjections = vi.fn();

vi.mock('../../../hooks/useActorMessageProjections', () => ({
	useActorMessageProjections: (args: unknown) => mockUseActorMessageProjections(args),
}));

import { ActorMessageProjectionFeed } from './ActorMessageProjectionFeed';

describe('ActorMessageProjectionFeed', () => {
	it('renders actor labels, target badges, and delivery states', () => {
		mockUseActorMessageProjections.mockReturnValue({
			rows: [
				{
					id: 'row-1',
					scope: 'task_timeline',
					eventKind: 'handoff',
					from: { kind: 'worker', label: 'Coder' },
					target: { kind: 'worker', label: 'Review' },
					targetResolution: 'queued',
					deliveryState: 'queued',
					title: 'Queued delivery',
					summary: 'Please review this PR.',
					severity: 'info',
					createdAt: 1700000000000,
				},
			],
			isLoading: false,
			isReconnecting: false,
		});

		render(
			<ActorMessageProjectionFeed
				scope="task_timeline"
				taskId="task-1"
				emptyLabel="Empty"
				loadingLabel="Loading"
				reconnectingLabel="Reconnecting"
			/>
		);

		expect(screen.getByText('Coder')).toBeTruthy();
		expect(screen.getByTestId('actor-target-badge').textContent).toContain('Review');
		expect(screen.getByTestId('delivery-state-badge').textContent).toBe('queued');
		expect(screen.getByText('Queued delivery')).toBeTruthy();
	});

	it('renders empty label when projection has no rows', () => {
		mockUseActorMessageProjections.mockReturnValue({
			rows: [],
			isLoading: false,
			isReconnecting: false,
		});

		render(
			<ActorMessageProjectionFeed
				scope="workflow_log"
				workflowRunId="run-1"
				emptyLabel="No events"
				loadingLabel="Loading"
				reconnectingLabel="Reconnecting"
			/>
		);

		expect(screen.getByText('No events')).toBeTruthy();
	});
});
