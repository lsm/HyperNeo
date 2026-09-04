import type { ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import { getThinkingOptionsForProvider, normalizeThinkingLevel } from '@hyperneo/shared';
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
}

export function TemplateModelFields({
  value,
  onChange,
  testId = 'template-model-fields',
}: TemplateModelFieldsProps) {
  const modelSelectId = `${testId}-model-select`;
  const thinkingSelectId = `${testId}-thinking-level`;

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const resolvedThinkingModes = useMemo(() => {
    if (!value.model) return undefined;
    const match = models.find(
      (model) => model.id === value.model && (!value.provider || model.provider === value.provider)
    );
    return match?.thinkingModes;
  }, [models, value.model, value.provider]);

  const thinkingOptions = useMemo(
    () =>
      getThinkingOptionsForProvider(
        value.provider ?? undefined,
        resolvedThinkingModes ?? undefined
      ),
    [value.provider, resolvedThinkingModes]
  );

  useEffect(() => {
    const supported = thinkingOptions.map((option) => option.value);
    if (modelsLoaded && value.thinkingLevel && !supported.includes(value.thinkingLevel)) {
      onChange({ ...value, thinkingLevel: null });
    }
  }, [modelsLoaded, thinkingOptions, value.thinkingLevel, value.provider, onChange]);

  function handleModelsLoad(loaded: ModelInfo[]) {
    setModels(loaded);
    setModelsLoaded(true);
  }

  function handleModelChange(model: string | undefined, selection?: WorkflowModelSelection) {
    const nextProvider = selection?.provider ?? null;
    const nextResolved = selection?.thinkingModes;
    const nextOptions = getThinkingOptionsForProvider(
      nextProvider ?? undefined,
      nextResolved ?? undefined
    ).map((option) => option.value);
    const nextThinkingLevel =
      value.thinkingLevel && !nextOptions.includes(value.thinkingLevel)
        ? null
        : value.thinkingLevel;

    onChange({
      ...value,
      model: model ?? null,
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
