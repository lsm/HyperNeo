import type { ThinkingLevel } from '@hyperneo/shared';
import { THINKING_LEVEL_LABELS, normalizeThinkingLevel } from '@hyperneo/shared';
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

const THINKING_LEVEL_OPTIONS: Array<{ value: '' | ThinkingLevel; label: string }> = [
  { value: '', label: 'Use app default' },
  { value: 'off', label: THINKING_LEVEL_LABELS.off },
  { value: 'think8k', label: THINKING_LEVEL_LABELS.think8k },
  { value: 'think16k', label: THINKING_LEVEL_LABELS.think16k },
  { value: 'think24k', label: THINKING_LEVEL_LABELS.think24k },
  { value: 'think32k', label: THINKING_LEVEL_LABELS.think32k },
];

export function TemplateModelFields({
  value,
  onChange,
  testId = 'template-model-fields',
}: TemplateModelFieldsProps) {
  function handleModelChange(model: string | undefined, selection?: WorkflowModelSelection) {
    onChange({
      ...value,
      model: model ?? null,
      provider: selection?.provider ?? null,
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
        <label class="block text-sm font-medium text-fg-soft mb-1.5">
          Model
          <span class="text-fg-muted text-xs ml-2">(optional)</span>
        </label>
        <WorkflowModelSelect
          value={value.model || undefined}
          provider={value.provider || undefined}
          onChange={handleModelChange}
          testId={`${testId}-model-select`}
        />
        <p class="mt-1.5 text-xs text-fg-faint leading-snug">
          Leave empty to use the space default model.
        </p>
      </div>

      <div>
        <label class="block text-sm font-medium text-fg-soft mb-1.5">
          Thinking Level
          <span class="text-fg-muted text-xs ml-2">(optional override)</span>
        </label>
        <select
          value={value.thinkingLevel || ''}
          onChange={handleThinkingLevelChange}
          data-testid={`${testId}-thinking-level`}
          class="w-full bg-surface-raised border border-line-strong rounded-lg px-4 py-2.5 text-fg focus:outline-none focus:border-accent"
        >
          {THINKING_LEVEL_OPTIONS.map((option) => (
            <option key={option.value || 'default'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
