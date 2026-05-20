import type {
	EvolutionScope,
	EvolutionScopeCreateResponse,
	EvolutionScopeKind,
	EvolutionScopeListResponse,
	EvolutionEvidenceListResponse,
	EvolutionMetricSnapshotCreateResponse,
	EvolutionMetricSnapshotListResponse,
	EvidenceRef,
	MetricDefinition,
	MetricDirection,
	MetricSnapshot,
	MetricSnapshotValues,
	SpaceGoal,
} from '@neokai/shared';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useMessageHub } from '../../hooks/useMessageHub';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

type ScopeTab = 'overview' | 'evidence' | 'metrics';

const SCOPE_KINDS: EvolutionScopeKind[] = ['mission', 'project', 'campaign', 'workflow', 'custom'];
const METRIC_DIRECTIONS: MetricDirection[] = ['increase', 'decrease', 'target', 'maintain'];

interface SpaceForgeProps {
	spaceId: string;
}

interface ScopeCreateDialogProps {
	isOpen: boolean;
	spaceId: string;
	goals: SpaceGoal[];
	onClose: () => void;
	onCreated: (scope: EvolutionScope) => void;
}

interface MetricDefinitionDraft {
	key: string;
	label: string;
	direction: MetricDirection;
	unit: string;
	targetValue: string;
}

interface SnapshotValueDraft {
	key: string;
	value: string;
}

function formatDate(value: number): string {
	return new Date(value).toLocaleString();
}

function formatKind(kind: string): string {
	return kind.replace(/_/g, ' ');
}

function parseMetricValue(value: string): string | number | boolean | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && trimmed !== '' ? parsed : trimmed;
}

function buildMetricDefinitions(drafts: MetricDefinitionDraft[]): MetricDefinition[] {
	return drafts
		.map((draft) => ({
			key: draft.key.trim(),
			label: draft.label.trim(),
			direction: draft.direction,
			unit: draft.unit.trim() || undefined,
			targetValue: draft.targetValue.trim() ? parseMetricValue(draft.targetValue) : undefined,
		}))
		.filter((metric) => metric.key && metric.label);
}

function getGoal(scope: EvolutionScope | null, goals: SpaceGoal[]): SpaceGoal | null {
	if (!scope?.spaceGoalId) return null;
	return goals.find((goal) => goal.id === scope.spaceGoalId) ?? null;
}

function ScopeCreateDialog({ isOpen, spaceId, goals, onClose, onCreated }: ScopeCreateDialogProps) {
	const { request } = useMessageHub();
	const [name, setName] = useState('');
	const [objective, setObjective] = useState('');
	const [kind, setKind] = useState<EvolutionScopeKind>('project');
	const [spaceGoalId, setSpaceGoalId] = useState('');
	const [metrics, setMetrics] = useState<MetricDefinitionDraft[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const recurringGoals = goals.filter(
		(goal) => goal.type === 'recurring' && goal.status !== 'archived'
	);

	const reset = () => {
		setName('');
		setObjective('');
		setKind('project');
		setSpaceGoalId('');
		setMetrics([]);
		setError(null);
	};

	const handleClose = () => {
		reset();
		onClose();
	};

	const addMetric = () => {
		setMetrics((current) => [
			...current,
			{ key: '', label: '', direction: 'increase', unit: '', targetValue: '' },
		]);
	};

	const updateMetric = (index: number, patch: Partial<MetricDefinitionDraft>) => {
		setMetrics((current) =>
			current.map((metric, metricIndex) =>
				metricIndex === index ? { ...metric, ...patch } : metric
			)
		);
	};

	const removeMetric = (index: number) => {
		setMetrics((current) => current.filter((_, metricIndex) => metricIndex !== index));
	};

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		const metricDefinitions = buildMetricDefinitions(metrics);
		const keys = metricDefinitions.map((metric) => metric.key);
		if (!name.trim()) {
			setError('Scope name is required');
			return;
		}
		if (!objective.trim()) {
			setError('Objective is required');
			return;
		}
		if (new Set(keys).size !== keys.length) {
			setError('Metric keys must be unique');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);
			const response = await request<EvolutionScopeCreateResponse>('evolution.scope.create', {
				params: {
					spaceId,
					kind,
					name: name.trim(),
					objective: objective.trim(),
					spaceGoalId: spaceGoalId || null,
					metricDefinitions,
				},
			});
			toast.success(`Scope "${response.scope.name}" created`);
			onCreated(response.scope);
			handleClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create scope');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Create Scope" size="lg">
			<form onSubmit={handleSubmit} class="space-y-4">
				{error && (
					<div class="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-400">
						{error}
					</div>
				)}

				<div>
					<label class="mb-1.5 block text-sm font-medium text-gray-200">Name</label>
					<input
						value={name}
						onInput={(event) => setName((event.target as HTMLInputElement).value)}
						placeholder="Improve code review loop"
						class="w-full rounded-lg border border-dark-700 bg-dark-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
						autoFocus
					/>
				</div>

				<div class="grid gap-4 md:grid-cols-2">
					<div>
						<label class="mb-1.5 block text-sm font-medium text-gray-300">Kind</label>
						<select
							value={kind}
							onChange={(event) =>
								setKind((event.target as HTMLSelectElement).value as EvolutionScopeKind)
							}
							class="w-full rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
						>
							{SCOPE_KINDS.map((option) => (
								<option key={option} value={option}>
									{formatKind(option)}
								</option>
							))}
						</select>
					</div>
					<div>
						<label class="mb-1.5 block text-sm font-medium text-gray-300">
							Linked recurring goal
						</label>
						<select
							aria-label="Linked recurring goal"
							value={spaceGoalId}
							onInput={(event) => setSpaceGoalId((event.target as HTMLSelectElement).value)}
							class="w-full rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
						>
							<option value="">None</option>
							{recurringGoals.map((goal) => (
								<option key={goal.id} value={goal.id}>
									{goal.title}
								</option>
							))}
						</select>
					</div>
				</div>

				<div>
					<label class="mb-1.5 block text-sm font-medium text-gray-300">Objective</label>
					<textarea
						value={objective}
						onInput={(event) => setObjective((event.target as HTMLTextAreaElement).value)}
						placeholder="What should this scope prove or improve?"
						rows={3}
						class="w-full resize-none rounded-lg border border-dark-700 bg-dark-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
					/>
				</div>

				<div class="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
					<div class="flex items-center justify-between gap-3">
						<div>
							<h3 class="text-sm font-medium text-gray-200">Metric definitions</h3>
							<p class="text-xs text-gray-500">Optional keys tracked by snapshots.</p>
						</div>
						<Button type="button" variant="secondary" size="sm" onClick={addMetric}>
							Add metric
						</Button>
					</div>
					{metrics.length === 0 ? (
						<p class="text-xs text-gray-600">No metrics yet.</p>
					) : (
						<div class="space-y-2">
							{metrics.map((metric, index) => (
								<div key={index} class="grid gap-2 md:grid-cols-[1fr_1fr_120px_100px_80px_auto]">
									<input
										value={metric.key}
										onInput={(event) =>
											updateMetric(index, { key: (event.target as HTMLInputElement).value })
										}
										placeholder="key"
										class="rounded-md border border-dark-700 bg-dark-800 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
									/>
									<input
										value={metric.label}
										onInput={(event) =>
											updateMetric(index, { label: (event.target as HTMLInputElement).value })
										}
										placeholder="Label"
										class="rounded-md border border-dark-700 bg-dark-800 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
									/>
									<select
										value={metric.direction}
										onChange={(event) =>
											updateMetric(index, {
												direction: (event.target as HTMLSelectElement).value as MetricDirection,
											})
										}
										class="rounded-md border border-dark-700 bg-dark-800 px-2 py-1.5 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
									>
										{METRIC_DIRECTIONS.map((direction) => (
											<option key={direction} value={direction}>
												{direction}
											</option>
										))}
									</select>
									<input
										value={metric.unit}
										onInput={(event) =>
											updateMetric(index, { unit: (event.target as HTMLInputElement).value })
										}
										placeholder="unit"
										class="rounded-md border border-dark-700 bg-dark-800 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
									/>
									<input
										value={metric.targetValue}
										onInput={(event) =>
											updateMetric(index, { targetValue: (event.target as HTMLInputElement).value })
										}
										placeholder="target"
										class="rounded-md border border-dark-700 bg-dark-800 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
									/>
									<button
										type="button"
										onClick={() => removeMetric(index)}
										class="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-white/5 hover:text-red-300"
									>
										Remove
									</button>
								</div>
							))}
						</div>
					)}
				</div>

				<div class="flex justify-end gap-2 border-t border-white/10 pt-4">
					<Button type="button" variant="ghost" onClick={handleClose} disabled={submitting}>
						Cancel
					</Button>
					<Button type="submit" disabled={submitting}>
						{submitting ? 'Creating…' : 'Create scope'}
					</Button>
				</div>
			</form>
		</Modal>
	);
}

function GoalSummary({ goal }: { goal: SpaceGoal }) {
	return (
		<div class="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
			<div class="mb-3 flex items-center justify-between gap-3">
				<div>
					<p class="text-xs uppercase tracking-wide text-blue-300">Linked recurring goal</p>
					<h3 class="text-sm font-medium text-gray-100">{goal.title}</h3>
				</div>
				<span class="rounded-full bg-blue-500/10 px-2 py-1 text-xs text-blue-200">
					{goal.progress}%
				</span>
			</div>
			<div class="mb-3 h-1.5 rounded-full bg-dark-800">
				<div
					class="h-full rounded-full bg-blue-400"
					style={{ width: `${Math.max(0, Math.min(100, goal.progress))}%` }}
				/>
			</div>
			{goal.summary && <p class="text-sm text-gray-300">{goal.summary}</p>}
			{goal.nextSteps.length > 0 && (
				<ul class="mt-3 space-y-1 text-xs text-gray-400">
					{goal.nextSteps.map((step) => (
						<li key={step}>Next: {step}</li>
					))}
				</ul>
			)}
		</div>
	);
}

function EvidenceTab({ scope }: { scope: EvolutionScope }) {
	const { request } = useMessageHub();
	const [evidence, setEvidence] = useState<EvidenceRef[]>([]);
	const [note, setNote] = useState('');
	const [loading, setLoading] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadEvidence = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
				scopeId: scope.id,
			});
			setEvidence(response.evidence ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load evidence');
		} finally {
			setLoading(false);
		}
	}, [request, scope.id]);

	useEffect(() => {
		loadEvidence().catch(() => undefined);
	}, [loadEvidence]);

	const handleAddNote = async (event: Event) => {
		event.preventDefault();
		if (!note.trim()) return;
		try {
			setSubmitting(true);
			setError(null);
			await request<{ evidence: EvidenceRef }>('evolution.evidence.addManualNote', {
				scopeId: scope.id,
				summary: note.trim(),
			});
			setNote('');
			await loadEvidence();
			toast.success('Evidence note attached');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to attach note');
		} finally {
			setSubmitting(false);
		}
	};

	const timeline = [...evidence].sort((a, b) => b.createdAt - a.createdAt);

	return (
		<div class="space-y-4">
			<form onSubmit={handleAddNote} class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
				<label class="mb-2 block text-sm font-medium text-gray-200">Attach manual note</label>
				<textarea
					value={note}
					onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
					placeholder="What happened? What evidence should Forge remember?"
					rows={3}
					class="w-full resize-none rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
				/>
				<div class="mt-3 flex justify-end">
					<Button type="submit" size="sm" disabled={submitting || !note.trim()}>
						{submitting ? 'Attaching…' : 'Attach note'}
					</Button>
				</div>
			</form>

			{error && (
				<div class="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
					{error}
				</div>
			)}

			<section class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
				<div class="mb-3 flex items-center justify-between">
					<h3 class="text-sm font-medium text-gray-100">Evidence timeline</h3>
					<span class="text-xs text-gray-500">{timeline.length} items</span>
				</div>
				{loading ? (
					<p class="text-sm text-gray-500">Loading evidence…</p>
				) : timeline.length === 0 ? (
					<p class="text-sm text-gray-500">No evidence attached yet.</p>
				) : (
					<div class="space-y-3">
						{timeline.map((item) => (
							<div key={item.id} class="rounded-lg border border-white/10 bg-dark-900/60 p-3">
								<div class="mb-1 flex items-center justify-between gap-3">
									<span class="rounded-full bg-white/5 px-2 py-0.5 text-xs text-gray-300">
										{formatKind(item.kind)}
									</span>
									<span class="text-xs text-gray-600">{formatDate(item.createdAt)}</span>
								</div>
								<p class="text-sm text-gray-200">{item.summary}</p>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function MetricsTab({ scope }: { scope: EvolutionScope }) {
	const { request } = useMessageHub();
	const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
	const [values, setValues] = useState<SnapshotValueDraft[]>(
		scope.metricDefinitions.map((metric) => ({ key: metric.key, value: '' }))
	);
	const [note, setNote] = useState('');
	const [loading, setLoading] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadSnapshots = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await request<EvolutionMetricSnapshotListResponse>(
				'evolution.metricSnapshot.list',
				{
					scopeId: scope.id,
				}
			);
			setSnapshots(response.snapshots ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load metric snapshots');
		} finally {
			setLoading(false);
		}
	}, [request, scope.id]);

	useEffect(() => {
		setValues(scope.metricDefinitions.map((metric) => ({ key: metric.key, value: '' })));
		loadSnapshots().catch(() => undefined);
	}, [loadSnapshots, scope.metricDefinitions]);

	const updateValue = (index: number, value: string) => {
		setValues((current) =>
			current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, value } : entry))
		);
	};

	const handleAddSnapshot = async (event: Event) => {
		event.preventDefault();
		const snapshotValues = values.reduce<MetricSnapshotValues>((acc, entry) => {
			if (entry.value.trim()) acc[entry.key] = parseMetricValue(entry.value);
			return acc;
		}, {});
		if (Object.keys(snapshotValues).length === 0) {
			setError('At least one metric value is required');
			return;
		}
		try {
			setSubmitting(true);
			setError(null);
			await request<EvolutionMetricSnapshotCreateResponse>('evolution.metricSnapshot.create', {
				params: {
					scopeId: scope.id,
					values: snapshotValues,
					source: 'manual',
					note: note.trim() || null,
				},
			});
			setValues((current) => current.map((entry) => ({ ...entry, value: '' })));
			setNote('');
			await loadSnapshots();
			toast.success('Metric snapshot added');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add metric snapshot');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div class="space-y-4">
			<section class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
				<h3 class="mb-3 text-sm font-medium text-gray-100">Metric definitions</h3>
				{scope.metricDefinitions.length === 0 ? (
					<p class="text-sm text-gray-500">No metric definitions for this scope.</p>
				) : (
					<div class="grid gap-3 md:grid-cols-2">
						{scope.metricDefinitions.map((metric) => (
							<div key={metric.key} class="rounded-lg border border-white/10 bg-dark-900/60 p-3">
								<div class="flex items-center justify-between gap-3">
									<p class="text-sm font-medium text-gray-100">{metric.label}</p>
									<span class="text-xs text-gray-500">{metric.direction}</span>
								</div>
								<p class="mt-1 text-xs text-gray-500">
									{metric.key}
									{metric.unit ? ` · ${metric.unit}` : ''}
								</p>
							</div>
						))}
					</div>
				)}
			</section>

			{scope.metricDefinitions.length > 0 && (
				<form
					onSubmit={handleAddSnapshot}
					class="rounded-xl border border-white/10 bg-white/[0.02] p-4"
				>
					<h3 class="mb-3 text-sm font-medium text-gray-100">Add metric snapshot</h3>
					<div class="grid gap-3 md:grid-cols-2">
						{values.map((entry, index) => {
							const metric = scope.metricDefinitions.find(
								(definition) => definition.key === entry.key
							);
							return (
								<label key={entry.key} class="block">
									<span class="mb-1 block text-xs text-gray-400">{metric?.label ?? entry.key}</span>
									<input
										value={entry.value}
										onInput={(event) =>
											updateValue(index, (event.target as HTMLInputElement).value)
										}
										placeholder={metric?.unit ?? 'value'}
										class="w-full rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
									/>
								</label>
							);
						})}
					</div>
					<textarea
						value={note}
						onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
						placeholder="Optional snapshot note"
						rows={2}
						class="mt-3 w-full resize-none rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
					/>
					<div class="mt-3 flex justify-end">
						<Button type="submit" size="sm" disabled={submitting}>
							{submitting ? 'Adding…' : 'Add snapshot'}
						</Button>
					</div>
				</form>
			)}

			{error && (
				<div class="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
					{error}
				</div>
			)}

			<section class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
				<h3 class="mb-3 text-sm font-medium text-gray-100">Snapshot history</h3>
				{loading ? (
					<p class="text-sm text-gray-500">Loading snapshots…</p>
				) : snapshots.length === 0 ? (
					<p class="text-sm text-gray-500">No metric snapshots yet.</p>
				) : (
					<div class="space-y-3">
						{snapshots.map((snapshot) => (
							<div key={snapshot.id} class="rounded-lg border border-white/10 bg-dark-900/60 p-3">
								<div class="mb-2 flex items-center justify-between gap-3">
									<span class="text-sm text-gray-200">{snapshot.source}</span>
									<span class="text-xs text-gray-600">{formatDate(snapshot.capturedAt)}</span>
								</div>
								<div class="flex flex-wrap gap-2">
									{Object.entries(snapshot.values).map(([key, value]) => (
										<span key={key} class="rounded-full bg-white/5 px-2 py-1 text-xs text-gray-300">
											{key}: {String(value)}
										</span>
									))}
								</div>
								{snapshot.note && <p class="mt-2 text-sm text-gray-400">{snapshot.note}</p>}
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function ScopeDetail({ scope, goals }: { scope: EvolutionScope; goals: SpaceGoal[] }) {
	const [tab, setTab] = useState<ScopeTab>('overview');
	const goal = getGoal(scope, goals);

	return (
		<div class="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
			<div class="border-b border-white/10 p-5">
				<div class="mb-2 flex flex-wrap items-center gap-2">
					<span class="rounded-full bg-cyan-500/10 px-2 py-1 text-xs text-cyan-300">
						{formatKind(scope.kind)}
					</span>
					{goal && (
						<span class="rounded-full bg-blue-500/10 px-2 py-1 text-xs text-blue-300">
							{goal.title}
						</span>
					)}
				</div>
				<h2 class="text-lg font-semibold text-gray-100">{scope.name}</h2>
				<p class="mt-1 text-sm text-gray-400">{scope.objective}</p>
			</div>
			<div class="flex gap-2 border-b border-white/10 px-5 py-3">
				{(['overview', 'evidence', 'metrics'] as const).map((item) => (
					<button
						key={item}
						type="button"
						onClick={() => setTab(item)}
						class={`rounded-lg px-3 py-1.5 text-sm capitalize transition-colors ${tab === item ? 'bg-white/10 text-gray-100' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'}`}
					>
						{item}
					</button>
				))}
			</div>
			<div class="flex-1 overflow-y-auto p-5">
				{tab === 'overview' && (
					<div class="space-y-4">
						{goal ? (
							<GoalSummary goal={goal} />
						) : (
							<div class="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-gray-500">
								No recurring goal linked.
							</div>
						)}
						<div class="grid gap-3 md:grid-cols-2">
							<div class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
								<p class="text-xs uppercase tracking-wide text-gray-500">Created</p>
								<p class="mt-1 text-sm text-gray-200">{formatDate(scope.createdAt)}</p>
							</div>
							<div class="rounded-xl border border-white/10 bg-white/[0.02] p-4">
								<p class="text-xs uppercase tracking-wide text-gray-500">Metrics</p>
								<p class="mt-1 text-sm text-gray-200">
									{scope.metricDefinitions.length} definitions
								</p>
							</div>
						</div>
					</div>
				)}
				{tab === 'evidence' && <EvidenceTab scope={scope} />}
				{tab === 'metrics' && <MetricsTab scope={scope} />}
			</div>
		</div>
	);
}

export function SpaceForge({ spaceId }: SpaceForgeProps) {
	const { request } = useMessageHub();
	const [scopes, setScopes] = useState<EvolutionScope[]>([]);
	const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const goals = spaceStore.goals.value;

	const loadScopes = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [scopeResponse] = await Promise.all([
				request<EvolutionScopeListResponse>('evolution.scope.list', { spaceId }),
				spaceStore.listGoals({ includeArchived: false }).catch(() => []),
			]);
			const nextScopes = scopeResponse.scopes ?? [];
			setScopes(nextScopes);
			setSelectedScopeId((current) => current ?? nextScopes[0]?.id ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load scopes');
		} finally {
			setLoading(false);
		}
	}, [request, spaceId]);

	useEffect(() => {
		setSelectedScopeId(null);
		loadScopes().catch(() => undefined);
	}, [loadScopes]);

	const selectedScope = useMemo(
		() => scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0] ?? null,
		[scopes, selectedScopeId]
	);

	const handleCreated = (scope: EvolutionScope) => {
		setScopes((current) => [scope, ...current]);
		setSelectedScopeId(scope.id);
	};

	return (
		<div class="flex h-full min-h-0 overflow-hidden">
			<aside class="flex w-80 flex-shrink-0 flex-col border-r border-white/10 bg-app-sidebar/40">
				<div class="border-b border-white/10 p-4">
					<div class="mb-3 flex items-center justify-between gap-3">
						<div>
							<h2 class="text-sm font-semibold text-gray-100">Scopes</h2>
							<p class="text-xs text-gray-500">Evidence-backed improvement areas</p>
						</div>
						<Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
							New
						</Button>
					</div>
					{error && (
						<div class="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
							{error}
						</div>
					)}
				</div>
				<div class="flex-1 overflow-y-auto p-2">
					{loading ? (
						<p class="p-3 text-sm text-gray-500">Loading scopes…</p>
					) : scopes.length === 0 ? (
						<div class="rounded-xl border border-dashed border-white/10 p-4 text-center">
							<p class="text-sm text-gray-400">No scopes yet.</p>
							<p class="mt-1 text-xs text-gray-600">Create one to track evidence and metrics.</p>
							<Button type="button" size="sm" class="mt-3" onClick={() => setCreateOpen(true)}>
								Create scope
							</Button>
						</div>
					) : (
						<div class="space-y-2">
							{scopes.map((scope) => {
								const goal = getGoal(scope, goals);
								const selected = selectedScope?.id === scope.id;
								return (
									<button
										key={scope.id}
										type="button"
										onClick={() => setSelectedScopeId(scope.id)}
										class={`w-full rounded-xl border p-3 text-left transition-colors ${selected ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'}`}
									>
										<div class="mb-1 flex items-center justify-between gap-2">
											<span class="truncate text-sm font-medium text-gray-100">{scope.name}</span>
											<span class="text-xs text-gray-500">{formatKind(scope.kind)}</span>
										</div>
										<p class="line-clamp-2 text-xs text-gray-500">{scope.objective}</p>
										{goal && <p class="mt-2 truncate text-xs text-blue-300">Goal: {goal.title}</p>}
									</button>
								);
							})}
						</div>
					)}
				</div>
			</aside>

			{selectedScope ? (
				<ScopeDetail scope={selectedScope} goals={goals} />
			) : (
				<div class="flex flex-1 items-center justify-center p-8 text-center">
					<div>
						<h2 class="text-lg font-medium text-gray-200">Create first Forge scope</h2>
						<p class="mt-2 text-sm text-gray-500">
							Scopes collect evidence, metrics, and linked goal context.
						</p>
						<Button type="button" class="mt-4" onClick={() => setCreateOpen(true)}>
							Create scope
						</Button>
					</div>
				</div>
			)}

			<ScopeCreateDialog
				isOpen={createOpen}
				spaceId={spaceId}
				goals={goals}
				onClose={() => setCreateOpen(false)}
				onCreated={handleCreated}
			/>
		</div>
	);
}
