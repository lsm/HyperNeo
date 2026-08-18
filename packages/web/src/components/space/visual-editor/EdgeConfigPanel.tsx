import { useCallback } from 'preact/hooks';
import type { WorkflowCondition, WorkflowConditionType } from './types';

export interface EdgeTransition {
  id: string;
  fromStepName: string;
  toStepName: string;
  condition: WorkflowCondition;
}

export interface EdgeConfigPanelProps {
  transition: EdgeTransition;
  onUpdateCondition: (
    transitionId: string,
    conditionType: WorkflowConditionType,
    expression?: string
  ) => void;
  onDelete: (transitionId: string) => void;
  onClose: () => void;
}

const CONDITION_LABELS: Record<WorkflowConditionType, string> = {
  always: 'Always',
  human: 'Human approval',
  condition: 'Expression',
  task_result: 'Task Result',
};

const CONDITION_TYPE_ORDER: WorkflowConditionType[] = [
  'always',
  'human',
  'condition',
  'task_result',
];

export function EdgeConfigPanel({
  transition,
  onUpdateCondition,
  onDelete,
  onClose,
}: EdgeConfigPanelProps) {
  const { id, fromStepName, toStepName, condition } = transition;

  const handleTypeChange = useCallback(
    (e: Event) => {
      const type = (e.target as HTMLSelectElement).value as WorkflowConditionType;
      const preserveExpression = type === 'condition' || type === 'task_result';
      onUpdateCondition(id, type, preserveExpression ? condition.expression : undefined);
    },
    [id, condition.expression, onUpdateCondition]
  );

  const handleExpressionChange = useCallback(
    (e: Event) => {
      const expression = (e.target as HTMLInputElement).value;
      onUpdateCondition(id, condition.type, expression);
    },
    [id, condition.type, onUpdateCondition]
  );

  const handleDelete = useCallback(() => {
    onDelete(id);
  }, [id, onDelete]);

  return (
    <div
      data-testid="edge-config-panel"
      class="flex flex-col gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg text-sm text-white"
    >
      <div class="flex items-center justify-between">
        <span class="font-semibold text-white text-sm">Transition</span>
        <button
          data-testid="close-button"
          class="text-gray-400 hover:text-white transition-colors"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400 w-10 shrink-0">From</span>
          <span
            data-testid="from-step-name"
            class="font-mono bg-dark-700 rounded px-2 py-0.5 text-gray-200 truncate"
          >
            {fromStepName}
          </span>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400 w-10 shrink-0">To</span>
          <span
            data-testid="to-step-name"
            class="font-mono bg-dark-700 rounded px-2 py-0.5 text-gray-200 truncate"
          >
            {toStepName}
          </span>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-xs text-gray-400 font-medium" for="condition-type-select">
          Condition
        </label>
        <select
          id="condition-type-select"
          data-testid="condition-type-select"
          class="bg-dark-700 border border-dark-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
          value={condition.type}
          onChange={handleTypeChange}
        >
          {CONDITION_TYPE_ORDER.map((type) => (
            <option key={type} value={type}>
              {CONDITION_LABELS[type]}
            </option>
          ))}
        </select>
      </div>

      {(condition.type === 'condition' || condition.type === 'task_result') && (
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-400 font-medium" for="condition-expression">
            {condition.type === 'task_result' ? 'Match value' : 'Expression'}
          </label>
          <input
            id="condition-expression"
            data-testid="condition-expression"
            type="text"
            class="bg-dark-700 border border-dark-600 rounded px-2 py-1 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
            placeholder={
              condition.type === 'task_result' ? 'e.g. passed, failed' : 'e.g. test -f output.txt'
            }
            value={condition.expression ?? ''}
            onInput={handleExpressionChange}
          />
        </div>
      )}

      <button
        data-testid="delete-transition-button"
        class="mt-1 w-full rounded px-2 py-1.5 text-xs font-medium text-red-400 border border-red-800 hover:bg-red-900/30 transition-colors"
        onClick={handleDelete}
      >
        Delete transition
      </button>
    </div>
  );
}
