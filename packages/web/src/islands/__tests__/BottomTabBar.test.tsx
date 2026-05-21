import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
	mockNavigateToSpace,
	mockNavigateToSpaceGoals,
	mockNavigateToSpaceForge,
	mockNavigateToSpaceTasks,
} = vi.hoisted(() => ({
	mockNavigateToSpace: vi.fn(),
	mockNavigateToSpaceGoals: vi.fn(),
	mockNavigateToSpaceForge: vi.fn(),
	mockNavigateToSpaceTasks: vi.fn(),
}));

vi.mock('../../lib/router', () => ({
	navigateToSessions: vi.fn(),
	navigateToSettings: vi.fn(),
	navigateToSpaces: vi.fn(),
	navigateToSpace: mockNavigateToSpace,
	navigateToSpaceGoals: mockNavigateToSpaceGoals,
	navigateToSpaceForge: mockNavigateToSpaceForge,
	navigateToSpaceTasks: mockNavigateToSpaceTasks,
	navigateToSpaceSessions: vi.fn(),
	navigateToSpaceAgent: vi.fn(),
	navigateToSpaceConfigure: vi.fn(),
}));

import {
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceViewModeSignal,
	navSectionSignal,
} from '../../lib/signals';
import { BottomTabBar } from '../BottomTabBar';

describe('BottomTabBar', () => {
	beforeEach(() => {
		navSectionSignal.value = 'spaces';
		currentSpaceIdSignal.value = 'space-1';
		currentSpaceViewModeSignal.value = 'overview';
		currentSpaceSessionIdSignal.value = null;
		currentSpaceTaskIdSignal.value = null;
		vi.clearAllMocks();
	});

	afterEach(() => cleanup());

	it('exposes Goals and Forge as mobile Space navigation entries', () => {
		const { container } = render(<BottomTabBar inline />);

		expect(screen.getByRole('tab', { name: 'Goals' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'Forge' })).toBeTruthy();
		expect(container.querySelector('[role="tablist"] > div')?.className).toContain(
			'overflow-x-auto'
		);

		fireEvent.click(screen.getByRole('tab', { name: 'Goals' }));
		expect(mockNavigateToSpaceGoals).toHaveBeenCalledWith('space-1');

		fireEvent.click(screen.getByRole('tab', { name: 'Forge' }));
		expect(mockNavigateToSpaceForge).toHaveBeenCalledWith('space-1');
	});

	it('marks Goals and Forge tabs active for their Space modes', () => {
		currentSpaceViewModeSignal.value = 'goals';
		const { rerender } = render(<BottomTabBar inline />);
		expect(screen.getByRole('tab', { name: 'Goals' }).getAttribute('aria-selected')).toBe('true');

		currentSpaceViewModeSignal.value = 'forge';
		rerender(<BottomTabBar inline />);
		expect(screen.getByRole('tab', { name: 'Forge' }).getAttribute('aria-selected')).toBe('true');
	});
});
