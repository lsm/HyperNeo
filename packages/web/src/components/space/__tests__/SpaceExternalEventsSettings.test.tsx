// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		get getHubIfConnected() {
			return mockGetHubIfConnected;
		},
	},
}));

vi.mock('../../../lib/toast', () => ({
	toast: {
		get success() {
			return mockToastSuccess;
		},
		get error() {
			return mockToastError;
		},
	},
}));

vi.mock('../../ui/Button', () => ({
	Button: ({ children, onClick, type, loading, disabled }) => (
		<button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
			{loading ? 'Loading...' : children}
		</button>
	),
}));

vi.mock('../../ui/CopyButton', () => ({
	CopyButton: ({ text, label }) => <button title={label}>{text}</button>,
}));

vi.mock('../../ui/Spinner', () => ({
	Spinner: () => <span>spinner</span>,
}));

import { SpaceExternalEventsSettings } from '../SpaceExternalEventsSettings';

const extensionResult = {
	extensions: [
		{
			source: 'github',
			status: 'started',
			config: {
				source: 'github',
				globallyEnabled: true,
				capabilities: { webhooks: true, polling: false, rpcConfig: true },
			},
		},
	],
};

const disabledExtensionResult = {
	extensions: [
		{
			source: 'github',
			status: 'stopped',
			config: {
				source: 'github',
				globallyEnabled: false,
				capabilities: { webhooks: true, polling: false, rpcConfig: true },
			},
		},
	],
};

const repoResult = {
	repositories: [
		{
			id: 'repo-1',
			owner: 'acme',
			repo: 'widgets',
			enabled: true,
			webhookEnabled: true,
			pollingEnabled: false,
			webhookSecret: 'configured',
			lastWebhookAt: null,
			lastPollAt: null,
		},
	],
};

function setupRequests() {
	mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
	mockRequest.mockImplementation((method) => {
		if (method === 'externalEvents.extensions.list') return Promise.resolve(extensionResult);
		if (method === 'space.github.listConfig') {
			return Promise.resolve({ spaceId: 'space-1', source: 'github', enabled: true, settings: {} });
		}
		if (method === 'space.github.listWatchedRepos') return Promise.resolve(repoResult);
		return Promise.resolve({});
	});
}

describe('SpaceExternalEventsSettings', () => {
	beforeEach(() => {
		cleanup();
		mockRequest.mockReset();
		mockGetHubIfConnected.mockReset();
		mockToastSuccess.mockReset();
		mockToastError.mockReset();
	});

	afterEach(() => cleanup());

	it('loads extension status, webhook URL, and watched repositories', async () => {
		setupRequests();
		const { findByText, getAllByText, getByText } = render(
			<SpaceExternalEventsSettings spaceId="space-1" />
		);
		expect(await findByText('github')).toBeTruthy();
		expect(getByText('started')).toBeTruthy();
		expect(getByText('acme/widgets')).toBeTruthy();
		expect(getAllByText(/webhook\/github\/space/)).toHaveLength(2);
		expect(mockRequest).toHaveBeenCalledWith('externalEvents.extensions.list', {});
		expect(mockRequest).toHaveBeenCalledWith('space.github.listConfig', { spaceId: 'space-1' });
		expect(mockRequest).toHaveBeenCalledWith('space.github.listWatchedRepos', {
			spaceId: 'space-1',
		});
	});

	it('keeps globally disabled GitHub manageable without calling GitHub RPCs', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockImplementation((method) => {
			if (method === 'externalEvents.extensions.list')
				return Promise.resolve(disabledExtensionResult);
			return Promise.reject(new Error('METHOD_NOT_FOUND'));
		});

		const { findByText, queryByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);

		expect(await findByText('github')).toBeTruthy();
		expect(await findByText('stopped')).toBeTruthy();
		expect(queryByText('acme/widgets')).toBeNull();
		expect(mockRequest).not.toHaveBeenCalledWith('space.github.listConfig', expect.anything());
		expect(mockRequest).not.toHaveBeenCalledWith(
			'space.github.listWatchedRepos',
			expect.anything()
		);
		expect(mockToastError).not.toHaveBeenCalled();
	});

	it('toggles space enablement', async () => {
		setupRequests();
		const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
		await findByText('github');

		fireEvent.click(getByText('Enabled for this space'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.github.disable', { spaceId: 'space-1' });
		});
	});

	it('updates repository toggles', async () => {
		setupRequests();
		const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
		await findByText('acme/widgets');

		fireEvent.click(getByText('Polling'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.github.watchRepo', {
				spaceId: 'space-1',
				owner: 'acme',
				repo: 'widgets',
				enabled: true,
				webhookEnabled: true,
				pollingEnabled: true,
			});
		});
	});

	it('shows connection errors when disconnected', async () => {
		mockGetHubIfConnected.mockReturnValue(null);

		render(<SpaceExternalEventsSettings spaceId="space-1" />);

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
		});
	});

	it('shows RPC failures when loading fails', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockRejectedValue(new Error('boom'));

		render(<SpaceExternalEventsSettings spaceId="space-1" />);

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith('Failed to load external event sources: boom');
		});
	});

	it('toggles global enablement', async () => {
		setupRequests();
		const { findByText, getAllByRole } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
		await findByText('github');

		fireEvent.click(getAllByRole('checkbox')[0]);

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('externalEvents.extensions.setGlobalEnabled', {
				source: 'github',
				enabled: false,
			});
		});
	});

	it('adds repository watches from owner/repo input', async () => {
		setupRequests();
		const { findByText, getByPlaceholderText, getByText } = render(
			<SpaceExternalEventsSettings spaceId="space-1" />
		);
		await findByText('github');

		fireEvent.input(getByPlaceholderText('owner/repository'), { target: { value: 'foo/bar' } });
		fireEvent.input(getByPlaceholderText('Webhook secret (optional)'), {
			target: { value: 'secret' },
		});
		fireEvent.click(getByText('Add watch'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.github.watchRepo', {
				spaceId: 'space-1',
				owner: 'foo',
				repo: 'bar',
				webhookSecret: 'secret',
				webhookEnabled: true,
				pollingEnabled: false,
			});
		});
	});

	it('removes watched repositories', async () => {
		setupRequests();
		const { findByText, getByText } = render(<SpaceExternalEventsSettings spaceId="space-1" />);
		await findByText('acme/widgets');

		fireEvent.click(getByText('Remove'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.github.unwatchRepo', {
				spaceId: 'space-1',
				owner: 'acme',
				repo: 'widgets',
			});
		});
	});
});
