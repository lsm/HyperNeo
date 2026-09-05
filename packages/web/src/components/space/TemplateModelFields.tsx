import type { ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import {
  getThinkingOptionsForProvider,
  normalizeThinkingLevel,
  THINKING_LEVEL_LABELS,
} from '@hyperneo/shared';
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  WorkflowModelSelect,
  type WorkflowModelSelection,
} from './visual-editor/WorkflowModelSelect';

export interface TemplateModelFieldsValue {
  model: string | null;
  provider: string | null;
  thinkingLevel: ThinkingLevel | null;
}

interface TemplateModelFieldsProps {
  value: TemplateModelFieldsValue;
  onChange: (value: TemplateModelFieldsValue) => void;
  testId?: string;
  hideModelSelect?: boolean;
}

export function TemplateModelFields({
  value,
  onChange,
  testId = 'template-model-fields',
  hideModelSelect = false,
}: TemplateModelFieldsProps) {
  const modelSelectId = `${testId}-model-select`;
  const thinkingSelectId = `${testId}-thinking-level`;

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const resolvedModel = useMemo(() => {
    if (!value.model) return undefined;
    return models.find(
      (model) => model.id === value.model && (!value.provider || model.provider === value.provider)
    );
  }, [models, value.model, value.provider]);

  const baseThinkingOptions = useMemo(
    () =>
      getThinkingOptionsForProvider(
        value.provider ?? undefined,
        resolvedModel?.thinkingModes ?? undefined
      ),
    [value.provider, resolvedModel]
  );

  const thinkingOptions = useMemo(() => {
    if (
      value.thinkingLevel &&
      !resolvedModel &&
      !baseThinkingOptions.some((option) => option.value === value.thinkingLevel)
    ) {
      return [
        ...baseThinkingOptions,
        { value: value.thinkingLevel, label: THINKING_LEVEL_LABELS[value.thinkingLevel] },
      ];
    }
    return baseThinkingOptions;
  }, [baseThinkingOptions, resolvedModel, value.thinkingLevel]);

  useEffect(() => {
    const supported = thinkingOptions.map((option) => option.value);
    if (
      modelsLoaded &&
      resolvedModel &&
      value.thinkingLevel &&
      !supported.includes(value.thinkingLevel)
    ) {
      onChange({ ...value, thinkingLevel: null });
    }
  }, [modelsLoaded, resolvedModel, thinkingOptions, value.thinkingLevel, value.provider, onChange]);

  function handleModelsLoad(loaded: ModelInfo[]) {
    setModels(loaded);
    setModelsLoaded(true);
  }

  function handleModelChange(model: string | undefined, selection?: WorkflowModelSelection) {
    if (!model) {
      onChange({ ...value, model: null, provider: null, thinkingLevel: value.thinkingLevel });
      return;
    }

    const nextProvider = selection?.provider || value.provider;
    const match = models.find(
      (m) => m.id === model && (!nextProvider || m.provider === nextProvider)
    );
    const nextOptions = getThinkingOptionsForProvider(
      nextProvider ?? undefined,
      match?.thinkingModes ?? undefined
    ).map((option) => option.value);
    const nextThinkingLevel =
      match && value.thinkingLevel && !nextOptions.includes(value.thinkingLevel)
        ? null
        : value.thinkingLevel;

    onChange({
      ...value,
      model,
      provider: nextProvider,
      thinkingLevel: nextThinkingLevel,
    });
  }

  function handleThinkingLevelChange(e: Event) {
    const raw = (e.currentTarget as HTMLSelectElement).value as '' | ThinkingLevel;
    onChange({
      ...value,
      thinkingLevel: raw ? normalizeThinkingLevel(raw) : null,
    });
  }

  return (
    <div class="space-y-4" data-testid={testId}>
      {!hideModelSelect && (
        <div>
          <label htmlFor={modelSelectId} class="block text-sm font-medium text-fg-soft mb-1.5">
            Model
            <span class="text-fg-muted text-xs ml-2">(optional)</span>
          </label>
          <WorkflowModelSelect
            id={modelSelectId}
            value={value.model || undefined}
            provider={value.provider || undefined}
            onChange={handleModelChange}
            onModelsLoad={handleModelsLoad}
            testId={modelSelectId}
          />
          <p class="mt-1.5 text-xs text-fg-faint leading-snug">
            Leave empty to use the space default model.
          </p>
        </div>
      )}

      <div>
        <label htmlFor={thinkingSelectId} class="block text-sm font-medium text-fg-soft mb-1.5">
          Thinking Level
          <span class="text-fg-muted text-xs ml-2">(optional override)</span>
        </label>
        <select
          id={thinkingSelectId}
          value={value.thinkingLevel || ''}
          onChange={handleThinkingLevelChange}
          data-testid={thinkingSelectId}
          class="w-full bg-surface-raised border border-line-strong rounded-lg px-4 py-2.5 text-fg focus:outline-none focus:border-accent"
        >
          <option value="">Use app default</option>
          {thinkingOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
