import type { ThinkingLevel } from '@hyperneo/shared';
import { normalizeThinkingLevel, THINKING_OPTIONS } from '@hyperneo/shared';
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

  const thinkingOptions = THINKING_OPTIONS;

  function handleModelChange(model: string | undefined, selection?: WorkflowModelSelection) {
    if (!model) {
      onChange({ ...value, model: null, provider: null, thinkingLevel: value.thinkingLevel });
      return;
    }

    const nextProvider = selection?.provider || value.provider;
    onChange({ ...value, model, provider: nextProvider });
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
      <div hidden={hideModelSelect}>
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
          onInput={handleThinkingLevelChange}
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
