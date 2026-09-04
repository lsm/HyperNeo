import type { ThinkingLevel } from '@hyperneo/shared';
import { getThinkingOptionsForProvider, normalizeThinkingLevel } from '@hyperneo/shared';
import { useEffect, useMemo } from 'preact/hooks';
import {
  WorkflowModelSelect,
  type WorkflowModelSelection,
} from './visual-editor/WorkflowModelSelect';

export interface TemplateModelFieldsValue {
  model: string | null;
  provider: string | null;
  thinkingLevel: ThinkingLevel | null;
  thinkingModes?: 'off' | 'on' | 'granular' | null;
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

  const thinkingOptions = useMemo(
    () =>
      getThinkingOptionsForProvider(value.provider ?? undefined, value.thinkingModes ?? undefined),
    [value.provider, value.thinkingModes]
  );

  useEffect(() => {
    const supported = thinkingOptions.map((option) => option.value);
    if (value.thinkingLevel && !supported.includes(value.thinkingLevel)) {
      onChange({ ...value, thinkingLevel: null });
    }
  }, [value.thinkingLevel, value.provider, value.thinkingModes, thinkingOptions, onChange]);

  function handleModelChange(model: string | undefined, selection?: WorkflowModelSelection) {
    const nextProvider = selection?.provider ?? null;
    const nextThinkingModes = selection?.thinkingModes ?? null;
    const nextOptions = getThinkingOptionsForProvider(
      nextProvider ?? undefined,
      nextThinkingModes ?? undefined
    ).map((option) => option.value);
    const nextThinkingLevel =
      value.thinkingLevel && !nextOptions.includes(value.thinkingLevel)
        ? null
        : value.thinkingLevel;

    onChange({
      ...value,
      model: model ?? null,
      provider: nextProvider,
      thinkingModes: nextThinkingModes,
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
