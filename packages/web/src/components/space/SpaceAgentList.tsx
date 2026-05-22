/**
 * Agents page for a Space.
 *
 * Shows the built-in Coordinator plus editable specialist agents, with basic
 * long-horizon configuration affordances for managed goals, Forge scopes,
 * reminders, and event subscriptions.
 */

import { useEffect, useState } from 'preact/hooks';
import type { AgentDriftReport, SpaceAgent } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { navigateToSpaceForge, navigateToSpaceGoals } from '../../lib/router';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { SpaceAgentEditor } from './SpaceAgentEditor';

interface AgentCardProps {
	agent: SpaceAgent;
	drifted: boolean;
	syncing: boolean;
	managedGoalCount: number;
	reminderCount: number;
	onEdit: (agent: SpaceAgent) => void;
	onDelete: (agent: SpaceAgent) => void;
	onSync: (agent: SpaceAgent) => void;
}

function isCoordinatorAgent(agent: SpaceAgent): boolean {
	return agent.name.toLowerCase() === 'coordinator' || agent.templateName === 'Coordinator';
}

function isConnectionUnavailableError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('Not connected');
}

function AgentStat({ label, value }: { label: string; value: string | number }) {
	return (
		<span class="rounded border border-white/10 bg-white/[0.025] px-2 py-1 text-xs text-gray-400">
			<span class="text-gray-200">{value}</span> {label}
		</span>
	);
}

function AgentCard({
	agent,
	drifted,
	syncing,
	managedGoalCount,
	reminderCount,
	onEdit,
	onDelete,
	onSync,
}: AgentCardProps) {
	const toolCount = agent.tools?.length ?? 0;
	const isCoordinator = isCoordinatorAgent(agent);

	return (
		<div
			class={`group rounded-lg border px-3 py-3 ${
				isCoordinator
					? 'border-purple-400/30 bg-purple-500/[0.06]'
					: 'border-white/10 bg-white/[0.025]'
			}`}
		>
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0 flex-1">
					<div class="flex min-w-0 flex-wrap items-center gap-2">
						<span class="truncate text-sm font-medium text-gray-100">{agent.name}</span>
						{isCoordinator && (
							<span class="rounded bg-purple-500/15 px-1.5 py-0.5 text-xs font-medium text-purple-200">
								Default Coordinator
							</span>
						)}
						{drifted && (
							<span
								class="inline-flex flex-shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300"
								title={`This agent was seeded from the "${agent.templateName}" preset and has drifted from the current definition.`}
							>
								Out of sync
							</span>
						)}
					</div>
					{agent.description && (
						<p class="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{agent.description}</p>
					)}
					<div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
						{agent.model && <span class="font-mono text-gray-500">{agent.model}</span>}
						{agent.model && toolCount > 0 && <span>·</span>}
						{toolCount > 0 && <span>{toolCount} tools</span>}
						{agent.tools?.slice(0, 3).map((tool) => (
							<span key={tool} class="rounded border border-white/10 px-1.5 py-0.5 text-gray-500">
								{tool}
							</span>
						))}
					</div>
					{isCoordinator && (
						<div class="mt-3 grid gap-2 rounded-lg border border-purple-400/15 bg-black/10 p-3 sm:grid-cols-2">
							<div>
								<p class="text-xs font-medium text-purple-100">Long-horizon scope</p>
								<div class="mt-2 flex flex-wrap gap-1.5">
									<AgentStat label="managed goals" value={managedGoalCount} />
									<AgentStat label="Forge scopes" value="Coming soon" />
								</div>
							</div>
							<div>
								<p class="text-xs font-medium text-purple-100">Automation</p>
								<div class="mt-2 flex flex-wrap gap-1.5">
									<AgentStat label="reminders" value={reminderCount} />
									<AgentStat label="event subscriptions" value="Coming soon" />
								</div>
							</div>
						</div>
					)}
				</div>
				<div class="flex flex-shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
					{drifted && (
						<button
							type="button"
							onClick={() => onSync(agent)}
							disabled={syncing}
							class="rounded-md px-2 py-1 text-xs text-amber-300 transition-colors hover:bg-white/5 hover:text-amber-200 disabled:opacity-50"
							title="Sync from template (overwrites description, tools, and prompt)"
						>
							{syncing ? 'Syncing…' : 'Sync'}
						</button>
					)}
					<button
						type="button"
						onClick={() => onEdit(agent)}
						class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-300"
						aria-label={`Edit ${agent.name}`}
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
							/>
						</svg>
					</button>
					<button
						type="button"
						onClick={() => onDelete(agent)}
						class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-red-400"
						aria-label={`Delete ${agent.name}`}
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
							/>
						</svg>
					</button>
				</div>
			</div>
		</div>
	);
}

function PlusIcon() {
	return (
		<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 4v16m8-8H4" />
		</svg>
	);
}

function AgentIcon() {
	return (
		<svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
			/>
		</svg>
	);
}

export function SpaceAgentList() {
	const agents = spaceStore.agents.value;
	const loading = spaceStore.loading.value;
	const spaceId = spaceStore.spaceId.value;
	const goals = spaceStore.goals.value;
	const schedules = spaceStore.schedules.value;
	const workflows = spaceStore.workflows.value;

	const [editorOpen, setEditorOpen] = useState(false);
	const [editingAgent, setEditingAgent] = useState<SpaceAgent | null>(null);
	const [deletingAgent, setDeletingAgent] = useState<SpaceAgent | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const [driftedAgentIds, setDriftedAgentIds] = useState<Set<string>>(new Set());
	const [syncingAgentId, setSyncingAgentId] = useState<string | null>(null);

	const driftKey = agents
		.map((a) => `${a.id}:${a.updatedAt}`)
		.sort()
		.join('|');

	useEffect(() => {
		if (!spaceId) return;

		let cancelled = false;
		let unsubscribe: (() => void) | null = null;
		const loadSchedules = () => {
			if (cancelled) return;
			spaceStore.listSchedules().catch((error) => {
				if (cancelled || !isConnectionUnavailableError(error)) return;
				unsubscribe?.();
				unsubscribe = connectionManager.onceConnected(loadSchedules);
			});
		};

		loadSchedules();

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [spaceId]);

	useEffect(() => {
		if (!spaceId) return;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) return;

		let cancelled = false;
		hub
			.request<{ report: AgentDriftReport }>('spaceAgent.getDriftReport', { spaceId })
			.then((result) => {
				if (cancelled) return;
				const ids = new Set<string>();
				for (const entry of result.report.agents) {
					if (entry.drifted) ids.add(entry.agentId);
				}
				setDriftedAgentIds(ids);
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, [spaceId, driftKey]);

	const handleSync = async (agent: SpaceAgent) => {
		if (!spaceId) return;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		setSyncingAgentId(agent.id);
		try {
			await hub.request('spaceAgent.syncFromTemplate', {
				spaceId,
				agentId: agent.id,
			});
			setDriftedAgentIds((prev) => {
				const next = new Set(prev);
				next.delete(agent.id);
				return next;
			});
			toast.success(`"${agent.name}" synced from template`);
		} catch (err) {
			toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setSyncingAgentId((current) => (current === agent.id ? null : current));
		}
	};

	const handleEdit = (agent: SpaceAgent) => {
		setEditingAgent(agent);
		setEditorOpen(true);
	};

	const handleCreate = () => {
		setEditingAgent(null);
		setEditorOpen(true);
	};

	const handleEditorClose = () => {
		setEditorOpen(false);
		setEditingAgent(null);
	};

	const handleDeleteClick = (agent: SpaceAgent) => {
		setDeletingAgent(agent);
		setDeleteError(null);
	};

	const handleDeleteConfirm = async () => {
		if (!deletingAgent) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			await spaceStore.deleteAgent(deletingAgent.id);
			setDeletingAgent(null);
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
		} finally {
			setDeleting(false);
		}
	};

	const handleGoalsClick = () => {
		if (!spaceId) return;
		navigateToSpaceGoals(spaceId);
	};

	const handleForgeClick = () => {
		if (!spaceId) return;
		navigateToSpaceForge(spaceId);
	};

	const existingAgentNames = agents.filter((a) => a.id !== editingAgent?.id).map((a) => a.name);
	const coordinator = agents.find(isCoordinatorAgent);
	const otherAgents = agents.filter((agent) => agent.id !== coordinator?.id);
	const visibleAgents = coordinator ? [coordinator, ...otherAgents] : agents;
	const activeGoals = goals.filter((goal) => goal.status === 'active');
	const activeSchedules = schedules.filter((schedule) => schedule.status === 'active');

	if (loading) {
		return (
			<div class="h-full overflow-y-auto">
				<div class="min-h-[calc(100%+1px)] flex items-center justify-center">
					<span class="text-xs text-gray-600 animate-pulse">Loading agents...</span>
				</div>
			</div>
		);
	}

	return (
		<div class="flex h-full min-h-0 flex-col">
			<div class="mb-3 flex flex-shrink-0 flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3 lg:flex-row lg:items-start lg:justify-between">
				<div class="flex min-w-0 items-start gap-3">
					<div class="mt-0.5 h-8 w-1 flex-shrink-0 rounded-full bg-purple-400/70" />
					<div class="min-w-0">
						<p class="text-xs font-semibold uppercase tracking-wider text-gray-300">
							Agents · {agents.length} configured
						</p>
						<p class="mt-1 text-xs text-gray-500">
							Coordinator is the default long-horizon Agent for this Space. Create specialists for
							coding, review, research, and QA.
						</p>
					</div>
				</div>
				<Button size="sm" onClick={handleCreate} icon={<PlusIcon />}>
					Create Agent
				</Button>
			</div>

			<div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto pr-3">
				<div class="min-h-[calc(100%+1px)] space-y-3 pb-4">
					<div class="grid gap-3 lg:grid-cols-3">
						<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
							<div class="flex items-center justify-between gap-2">
								<p class="text-xs font-semibold uppercase tracking-wider text-gray-400">
									Managed goals
								</p>
								<button
									type="button"
									class="text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
									onClick={handleGoalsClick}
									disabled={!spaceId}
								>
									View
								</button>
							</div>
							<p class="mt-2 text-2xl font-semibold text-gray-100">{activeGoals.length}</p>
							<p class="mt-1 text-xs text-gray-500">Active goals Coordinator can track.</p>
						</div>
						<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
							<div class="flex items-center justify-between gap-2">
								<p class="text-xs font-semibold uppercase tracking-wider text-gray-400">
									Forge scopes
								</p>
								<button
									type="button"
									class="text-xs text-blue-300 hover:text-blue-200 disabled:opacity-50"
									onClick={handleForgeClick}
									disabled={!spaceId}
								>
									Open Forge
								</button>
							</div>
							<div class="mt-2 rounded border border-white/10 bg-dark-800 px-2 py-1.5 text-xs text-gray-500">
								Per-Agent Forge scope policy coming soon.
							</div>
							<p class="mt-1 text-xs text-gray-500">
								Open Forge to review current evidence, lessons, and proposals.
							</p>
						</div>
						<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
							<p class="text-xs font-semibold uppercase tracking-wider text-gray-400">
								Reminders and events
							</p>
							<div class="mt-2 rounded border border-white/10 bg-dark-800 px-2 py-1.5 text-xs text-gray-500">
								Event subscriptions coming soon.
							</div>
							<p class="mt-1 text-xs text-gray-500">
								{activeSchedules.length} active reminders · event subscriptions not yet configured
							</p>
						</div>
					</div>

					{visibleAgents.length === 0 ? (
						<div class="flex flex-col items-center justify-center py-12 text-center">
							<div class="w-10 h-10 rounded-full bg-dark-800 flex items-center justify-center mb-3">
								<AgentIcon />
							</div>
							<p class="text-sm text-gray-400 font-medium">No agents yet</p>
							<p class="text-xs text-gray-600 mt-1">Create one to get started.</p>
							<div class="mt-4">
								<Button size="sm" variant="secondary" onClick={handleCreate}>
									Create Agent
								</Button>
							</div>
						</div>
					) : (
						<div class="space-y-2">
							{visibleAgents.map((agent) => (
								<AgentCard
									key={agent.id}
									agent={agent}
									drifted={driftedAgentIds.has(agent.id)}
									syncing={syncingAgentId === agent.id}
									managedGoalCount={activeGoals.length}
									reminderCount={activeSchedules.length}
									onEdit={handleEdit}
									onDelete={handleDeleteClick}
									onSync={handleSync}
								/>
							))}
						</div>
					)}

					<div class="rounded-lg border border-white/10 bg-white/[0.025] p-3">
						<p class="text-xs font-semibold uppercase tracking-wider text-gray-400">
							Workflow usage
						</p>
						<p class="mt-1 text-xs text-gray-500">
							{workflows.length} workflows can reference these agents. Edit workflows to assign
							specialists.
						</p>
					</div>
				</div>
			</div>

			{editorOpen && (
				<SpaceAgentEditor
					agent={editingAgent}
					existingAgentNames={existingAgentNames}
					onSave={handleEditorClose}
					onCancel={handleEditorClose}
				/>
			)}

			{deletingAgent && (
				<ConfirmModal
					isOpen
					onClose={() => {
						setDeletingAgent(null);
						setDeleteError(null);
					}}
					onConfirm={handleDeleteConfirm}
					title="Delete Agent"
					message={`Are you sure you want to delete "${deletingAgent.name}"? This action cannot be undone.`}
					confirmText="Delete"
					confirmButtonVariant="danger"
					isLoading={deleting}
					error={deleteError}
				/>
			)}
		</div>
	);
}
