import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ModelInfo } from '@neokai/shared';
import { connectionManager } from '../../../lib/connection-manager';
import {
	groupModelsByProvider,
	mapRawModelsToModelInfos,
	PROVIDER_LABELS,
	getProviderLabel,
	type RawModelEntry,
} from '../../../hooks/useModelSwitcher';

export interface WorkflowModelSelection {
	modelId: string;
	provider: string;
}

interface WorkflowModelSelectProps {
	value?: string;
	provider?: string;
	onChange: (value: string | undefined, selection?: WorkflowModelSelection) => void;
	testId: string;
	className?: string;
}

type LoadState = 'loading' | 'ready' | 'no-providers';

function dedupeModelsByProviderAndId(models: ModelInfo[]): ModelInfo[] {
	const seen = new Set<string>();
	const deduped: ModelInfo[] = [];
	for (const model of models) {
		const key = `${model.provider}:${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(model);
	}
	return deduped;
}

function encodeModelValue(model: ModelInfo): string {
	return `${model.provider}:${model.id}`;
}

function decodeModelValue(value: string): WorkflowModelSelection {
	const separator = value.indexOf(':');
	if (separator === -1) return { provider: '', modelId: value };
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

export function WorkflowModelSelect({
	value,
	provider,
	onChange,
	testId,
	className = 'w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed',
}: WorkflowModelSelectProps) {
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [loadState, setLoadState] = useState<LoadState>('loading');

	useEffect(() => {
		let cancelled = false;

		async function loadModels() {
			try {
				const hub = await connectionManager.getHub();
				if (cancelled) return;
				const response = (await hub.request('models.list', {
					useCache: true,
				})) as { models: RawModelEntry[] };
				if (cancelled) return;
				const loaded = dedupeModelsByProviderAndId(mapRawModelsToModelInfos(response.models ?? []));
				setModels(loaded);
				setLoadState(loaded.length > 0 ? 'ready' : 'no-providers');
			} catch {
				if (!cancelled) {
					setModels([]);
					setLoadState('no-providers');
				}
			}
		}

		void loadModels();
		return () => {
			cancelled = true;
		};
	}, []);

	const selectedValue = provider && value ? `${provider}:${value}` : value || '';
	const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);
	const hasCurrentOutsideList =
		!!value &&
		!models.some((model) => model.id === value && (!provider || model.provider === provider));

	if (loadState === 'loading') {
		return (
			<select data-testid={testId} disabled class={className}>
				<option>Loading models…</option>
			</select>
		);
	}

	if (loadState === 'no-providers') {
		return (
			<select data-testid={testId} disabled class={className}>
				<option>No providers available</option>
			</select>
		);
	}

	// Native select remains intentionally simple here because OpenRouter is capped server-side;
	// the primary status-bar and fallback settings pickers provide searchable custom menus.
	return (
		<select
			data-testid={testId}
			value={selectedValue}
			onChange={(e) => {
				const nextValue = (e.currentTarget as HTMLSelectElement).value;
				if (!nextValue) {
					onChange(undefined);
					return;
				}
				const selection = decodeModelValue(nextValue);
				onChange(selection.modelId, selection);
			}}
			class={className}
		>
			<option value="">— No override —</option>
			{hasCurrentOutsideList && (
				<option
					value={selectedValue}
				>{`Current (${provider ? `${provider}:` : ''}${value})`}</option>
			)}
			{Array.from(groupedModels.entries()).map(([provider, providerModels]) => (
				<optgroup key={provider} label={PROVIDER_LABELS[provider] || getProviderLabel(provider)}>
					{providerModels.map((model) => (
						<option key={`${provider}:${model.id}`} value={encodeModelValue(model)}>
							{`${model.name} (${model.id})`}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}
