/**
 * SpaceExternalEventsSettings — external event source configuration for a Space.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/Button.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { Spinner } from '../ui/Spinner.tsx';

interface SpaceExternalEventsSettingsProps {
	spaceId: string;
	disabled?: boolean;
}

interface ExtensionConfig {
	source: string;
	globallyEnabled: boolean;
	capabilities: {
		webhooks?: boolean;
		polling?: boolean;
		rpcConfig?: boolean;
	};
	settings?: Record<string, unknown>;
}

interface ExtensionStatus {
	source: string;
	status: 'started' | 'stopped';
	config: ExtensionConfig;
}

interface GitHubWatchedRepo {
	id: string;
	owner: string;
	repo: string;
	enabled: boolean;
	webhookEnabled: boolean;
	pollingEnabled: boolean;
	webhookSecret: 'configured' | null;
	lastWebhookAt: number | null;
	lastPollAt: number | null;
}

interface GitHubSpaceConfig {
	spaceId: string;
	source: 'github';
	enabled: boolean;
	settings: Record<string, unknown>;
}

const WEBHOOK_PATH = '/webhook/github/space';

function getWebhookUrl(): string {
	if (typeof window === 'undefined') return WEBHOOK_PATH;
	return new URL(WEBHOOK_PATH, window.location.origin).toString();
}

function formatCapabilities(capabilities: ExtensionConfig['capabilities']): string[] {
	return [
		capabilities.webhooks !== false ? 'webhooks' : null,
		capabilities.polling ? 'polling' : null,
		capabilities.rpcConfig ? 'RPC config' : null,
	].filter(Boolean) as string[];
}

function formatTimestamp(value: number | null): string {
	if (!value) return 'never';
	return new Date(value).toLocaleString();
}

function splitRepoInput(value: string): { owner: string; repo: string } | null {
	const trimmed = value.trim().replace(/^https:\/\/github\.com\//, '');
	const [owner, repo] = trimmed.split('/');
	if (!owner || !repo) return null;
	return { owner, repo: repo.replace(/\.git$/, '') };
}

export function SpaceExternalEventsSettings({
	spaceId,
	disabled = false,
}: SpaceExternalEventsSettingsProps) {
	const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
	const [repos, setRepos] = useState<GitHubWatchedRepo[]>([]);
	const [spaceConfig, setSpaceConfig] = useState<GitHubSpaceConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [repoInput, setRepoInput] = useState('');
	const [webhookSecret, setWebhookSecret] = useState('');
	const [formError, setFormError] = useState<string | null>(null);
	const refreshTokenRef = useRef(0);

	const githubExtension = extensions.find((extension) => extension.source === 'github');
	const githubGloballyEnabled = githubExtension?.config.globallyEnabled ?? false;
	const githubRpcConfigEnabled = githubExtension?.config.capabilities.rpcConfig ?? false;
	const githubControlsEnabled = githubGloballyEnabled && githubRpcConfigEnabled;
	const githubSpaceEnabled = spaceConfig?.enabled ?? true;
	const webhookUrl = useMemo(getWebhookUrl, []);

	async function refresh(): Promise<void> {
		const refreshToken = refreshTokenRef.current + 1;
		refreshTokenRef.current = refreshToken;
		const refreshSpaceId = spaceId;
		const isCurrentRefresh = () =>
			refreshTokenRef.current === refreshToken && refreshSpaceId === spaceId;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			if (isCurrentRefresh()) {
				toast.error('Not connected to server');
				setLoading(false);
			}
			return;
		}
		try {
			setLoading(true);
			const extensionResult = await hub.request<{ extensions: ExtensionStatus[] }>(
				'externalEvents.extensions.list',
				{}
			);
			if (!isCurrentRefresh()) return;
			setExtensions(extensionResult.extensions);

			const github = extensionResult.extensions.find((extension) => extension.source === 'github');
			if (!github?.config.globallyEnabled || !github.config.capabilities.rpcConfig) {
				setSpaceConfig(null);
				setRepos([]);
				return;
			}

			const [configResult, repoResult] = await Promise.all([
				hub.request<GitHubSpaceConfig | null>('space.github.listConfig', {
					spaceId: refreshSpaceId,
				}),
				hub.request<{ repositories: GitHubWatchedRepo[] }>('space.github.listWatchedRepos', {
					spaceId: refreshSpaceId,
				}),
			]);
			if (!isCurrentRefresh()) return;
			setSpaceConfig(configResult);
			setRepos(repoResult.repositories);
		} catch (err) {
			if (!isCurrentRefresh()) return;
			toast.error(
				`Failed to load external event sources: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			if (isCurrentRefresh()) setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, [spaceId]);

	async function setGlobalEnabled(source: string, enabled: boolean): Promise<void> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setBusy(`global:${source}`);
			await hub.request('externalEvents.extensions.setGlobalEnabled', { source, enabled });
			toast.success(`${source} ${enabled ? 'enabled' : 'disabled'} globally`);
			await refresh();
		} catch (err) {
			toast.error(
				`Failed to update ${source}: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			setBusy(null);
		}
	}

	async function setSpaceEnabled(enabled: boolean): Promise<void> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setBusy('space:github');
			await hub.request(enabled ? 'space.github.enable' : 'space.github.disable', { spaceId });
			toast.success(`GitHub events ${enabled ? 'enabled' : 'disabled'} for this space`);
			await refresh();
		} catch (err) {
			toast.error(
				`Failed to update GitHub events: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			setBusy(null);
		}
	}

	async function addRepo(event: Event): Promise<void> {
		event.preventDefault();
		const parsed = splitRepoInput(repoInput);
		if (!parsed) {
			setFormError('Enter a repository as owner/name or https://github.com/owner/name');
			return;
		}
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setBusy('repo:add');
			setFormError(null);
			const secret = webhookSecret.trim();
			await hub.request('space.github.watchRepo', {
				spaceId,
				owner: parsed.owner,
				repo: parsed.repo,
				webhookSecret: secret || undefined,
				webhookEnabled: Boolean(secret),
				pollingEnabled: !secret,
			});
			setRepoInput('');
			setWebhookSecret('');
			toast.success(`Watching ${parsed.owner}/${parsed.repo}`);
			await refresh();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	async function updateRepo(
		repo: GitHubWatchedRepo,
		patch: Partial<GitHubWatchedRepo>
	): Promise<void> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setBusy(`repo:${repo.id}`);
			await hub.request('space.github.watchRepo', {
				spaceId,
				owner: repo.owner,
				repo: repo.repo,
				enabled: patch.enabled ?? repo.enabled,
				webhookEnabled: patch.webhookEnabled ?? repo.webhookEnabled,
				pollingEnabled: patch.pollingEnabled ?? repo.pollingEnabled,
			});
			await refresh();
		} catch (err) {
			toast.error(
				`Failed to update ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			setBusy(null);
		}
	}

	async function removeRepo(repo: GitHubWatchedRepo): Promise<void> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setBusy(`repo:${repo.id}`);
			await hub.request('space.github.unwatchRepo', {
				spaceId,
				owner: repo.owner,
				repo: repo.repo,
			});
			toast.success(`Stopped watching ${repo.owner}/${repo.repo}`);
			await refresh();
		} catch (err) {
			toast.error(
				`Failed to remove ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			setBusy(null);
		}
	}

	return (
		<section class="space-y-4" data-testid="space-external-events-settings">
			<div>
				<h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
					External event sources
				</h3>
				<p class="mt-1 text-xs text-gray-500">
					Enable source extensions globally, then choose which repositories can trigger work in this
					space.
				</p>
			</div>

			{loading ? (
				<div class="flex items-center gap-2 py-2 text-xs text-gray-500">
					<Spinner size="sm" />
					Loading external event sources…
				</div>
			) : (
				<div class="space-y-4">
					<div class="space-y-2">
						{extensions.length === 0 ? (
							<div class="rounded-lg border border-dark-700 bg-dark-800 px-3 py-3 text-sm text-gray-500">
								No external event extensions registered.
							</div>
						) : (
							extensions.map((extension) => (
								<ExtensionCard
									key={extension.source}
									extension={extension}
									disabled={disabled || busy === `global:${extension.source}`}
									onToggle={(enabled) => setGlobalEnabled(extension.source, enabled)}
								/>
							))
						)}
					</div>

					<div class="rounded-lg border border-dark-700 bg-dark-800 px-3 py-3">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<div class="text-sm font-medium text-gray-200">GitHub repositories</div>
								<p class="mt-0.5 text-xs text-gray-500">
									Watch pull request and review activity for this space.
								</p>
							</div>
							<label
								class={cn(
									'flex items-center gap-2 text-xs text-gray-300',
									disabled && 'opacity-60'
								)}
							>
								<input
									type="checkbox"
									checked={githubSpaceEnabled}
									disabled={disabled || !githubControlsEnabled || busy === 'space:github'}
									onChange={() => setSpaceEnabled(!githubSpaceEnabled)}
									class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
								/>
								Enabled for this space
							</label>
						</div>

						<div class="mt-3 rounded-lg border border-white/10 bg-dark-850 px-3 py-2">
							<div class="text-[11px] uppercase tracking-wider text-gray-500">Webhook endpoint</div>
							<div class="mt-1 flex items-center gap-2">
								<code class="min-w-0 flex-1 truncate text-xs text-gray-300">{webhookUrl}</code>
								<CopyButton text={webhookUrl} label="Copy webhook URL" />
							</div>
							<p class="mt-1 text-xs text-gray-600">
								Use a public HTTPS tunnel for local development. Configure GitHub webhooks for
								pull_request, issue_comment, pull_request_review, and pull_request_review_comment
								events.
							</p>
						</div>

						<form
							onSubmit={addRepo}
							class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
						>
							<input
								type="text"
								value={repoInput}
								onInput={(event) => setRepoInput((event.target as HTMLInputElement).value)}
								placeholder="owner/repository"
								disabled={disabled || !githubControlsEnabled}
								class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
							/>
							<input
								type="password"
								value={webhookSecret}
								onInput={(event) => setWebhookSecret((event.target as HTMLInputElement).value)}
								placeholder="Webhook secret (optional)"
								disabled={disabled || !githubControlsEnabled}
								class="rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
							/>
							<Button
								type="submit"
								size="sm"
								loading={busy === 'repo:add'}
								disabled={disabled || !githubControlsEnabled || busy === 'repo:add'}
							>
								Add watch
							</Button>
						</form>
						{formError && <p class="mt-2 text-xs text-red-300">{formError}</p>}

						<div class="mt-3 space-y-2">
							{repos.length === 0 ? (
								<p class="rounded-lg border border-dashed border-dark-600 px-3 py-3 text-sm text-gray-500">
									No repositories watched yet.
								</p>
							) : (
								repos.map((repo) => (
									<GitHubRepoRow
										key={repo.id}
										repo={repo}
										disabled={disabled || busy === `repo:${repo.id}` || !githubControlsEnabled}
										onUpdate={(patch) => updateRepo(repo, patch)}
										onRemove={() => removeRepo(repo)}
									/>
								))
							)}
						</div>
					</div>
				</div>
			)}
		</section>
	);
}

interface ExtensionCardProps {
	extension: ExtensionStatus;
	disabled: boolean;
	onToggle: (enabled: boolean) => Promise<void>;
}

function ExtensionCard({ extension, disabled, onToggle }: ExtensionCardProps) {
	const capabilities = formatCapabilities(extension.config.capabilities);
	return (
		<label
			class={cn(
				'flex items-start gap-3 rounded-lg border border-dark-700 bg-dark-800 px-3 py-2.5',
				disabled && 'opacity-60'
			)}
		>
			<input
				type="checkbox"
				checked={extension.config.globallyEnabled}
				disabled={disabled}
				onChange={() => onToggle(!extension.config.globallyEnabled)}
				class="mt-0.5 h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
			/>
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-sm font-medium text-gray-200 capitalize">{extension.source}</span>
					<span
						class={cn(
							'rounded-full px-2 py-0.5 text-[11px]',
							extension.status === 'started'
								? 'bg-green-500/10 text-green-300'
								: 'bg-gray-500/10 text-gray-400'
						)}
					>
						{extension.status}
					</span>
				</div>
				<div class="mt-1 flex flex-wrap gap-1">
					{capabilities.map((capability) => (
						<span
							key={capability}
							class="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-400"
						>
							{capability}
						</span>
					))}
					{capabilities.length === 0 && (
						<span class="text-xs text-gray-600">No capabilities enabled</span>
					)}
				</div>
			</div>
		</label>
	);
}

interface GitHubRepoRowProps {
	repo: GitHubWatchedRepo;
	disabled: boolean;
	onUpdate: (patch: Partial<GitHubWatchedRepo>) => Promise<void>;
	onRemove: () => Promise<void>;
}

function GitHubRepoRow({ repo, disabled, onUpdate, onRemove }: GitHubRepoRowProps) {
	return (
		<div
			class={cn(
				'rounded-lg border border-dark-600 bg-dark-850 px-3 py-2.5',
				disabled && 'opacity-60'
			)}
		>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="min-w-0">
					<div class="truncate font-mono text-sm text-gray-200">
						{repo.owner}/{repo.repo}
					</div>
					<div class="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-500">
						<span>secret {repo.webhookSecret ? 'configured' : 'missing'}</span>
						<span>last webhook {formatTimestamp(repo.lastWebhookAt)}</span>
						<span>last poll {formatTimestamp(repo.lastPollAt)}</span>
					</div>
				</div>
				<button
					type="button"
					onClick={onRemove}
					disabled={disabled}
					class="text-xs text-red-400 hover:text-red-300 disabled:cursor-not-allowed disabled:text-red-900"
				>
					Remove
				</button>
			</div>
			<div class="mt-3 flex flex-wrap gap-4">
				<label class="flex items-center gap-2 text-xs text-gray-300">
					<input
						type="checkbox"
						checked={repo.enabled}
						disabled={disabled}
						onChange={() => onUpdate({ enabled: !repo.enabled })}
						class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
					/>
					Enabled
				</label>
				<label class="flex items-center gap-2 text-xs text-gray-300">
					<input
						type="checkbox"
						checked={repo.webhookEnabled}
						disabled={disabled}
						onChange={() => onUpdate({ webhookEnabled: !repo.webhookEnabled })}
						class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
					/>
					Webhooks
				</label>
				<label class="flex items-center gap-2 text-xs text-gray-300">
					<input
						type="checkbox"
						checked={repo.pollingEnabled}
						disabled={disabled}
						onChange={() => onUpdate({ pollingEnabled: !repo.pollingEnabled })}
						class="h-4 w-4 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
					/>
					Polling
				</label>
			</div>
		</div>
	);
}
