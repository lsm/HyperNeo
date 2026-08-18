import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal.tsx';
import type { SpaceExportBundle } from '@hyperneo/shared';

export type ConflictResolutionStrategy = 'skip' | 'rename' | 'replace';

export interface ImportPreview {
  name: string;
  action: 'create' | 'conflict';
  existingId?: string;
}

export interface ImportPreviewResult {
  agents: ImportPreview[];
  workflows: ImportPreview[];
  validationErrors: string[];
}

export interface ImportConflictResolution {
  agents?: Record<string, ConflictResolutionStrategy>;
  workflows?: Record<string, ConflictResolutionStrategy>;
}

interface ImportPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (resolution: ImportConflictResolution) => void;
  preview: ImportPreviewResult;
  bundle: SpaceExportBundle;
  isExecuting: boolean;
}

const STRATEGY_LABELS: Record<ConflictResolutionStrategy, string> = {
  skip: 'Skip',
  rename: 'Import as copy',
  replace: 'Replace existing',
};

function ConflictSelector({
  name,
  value,
  onChange,
}: {
  name: string;
  value: ConflictResolutionStrategy;
  onChange: (v: ConflictResolutionStrategy) => void;
}) {
  return (
    <select
      aria-label={`Conflict resolution for ${name}`}
      value={value}
      onInput={(e) =>
        onChange((e.currentTarget as HTMLSelectElement).value as ConflictResolutionStrategy)
      }
      class="text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      {(Object.keys(STRATEGY_LABELS) as ConflictResolutionStrategy[]).map((s) => (
        <option key={s} value={s}>
          {STRATEGY_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

function ItemRow({
  item,
  strategy,
  onStrategyChange,
}: {
  item: ImportPreview;
  strategy: ConflictResolutionStrategy;
  onStrategyChange: (s: ConflictResolutionStrategy) => void;
}) {
  const isConflict = item.action === 'conflict';
  return (
    <div class="flex items-center justify-between gap-3 py-1.5">
      <div class="flex items-center gap-2 min-w-0">
        {isConflict ? (
          <span class="flex-shrink-0 w-4 h-4 text-yellow-400" aria-label="conflict">
            <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4">
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        ) : (
          <span class="flex-shrink-0 w-4 h-4 text-green-400" aria-label="new">
            <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4">
              <path
                fillRule="evenodd"
                d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm4.28 10.28a.75.75 0 000-1.06l-3-3a.75.75 0 10-1.06 1.06l1.72 1.72H8.25a.75.75 0 000 1.5h5.69l-1.72 1.72a.75.75 0 101.06 1.06l3-3z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        )}
        <span class="text-sm text-gray-200 truncate">{item.name}</span>
        {!isConflict && <span class="text-xs text-green-400 flex-shrink-0">new</span>}
        {isConflict && <span class="text-xs text-yellow-400 flex-shrink-0">conflict</span>}
      </div>
      {isConflict && (
        <ConflictSelector name={item.name} value={strategy} onChange={onStrategyChange} />
      )}
    </div>
  );
}

export function ImportPreviewDialog({
  isOpen,
  onClose,
  onConfirm,
  preview,
  bundle,
  isExecuting,
}: ImportPreviewDialogProps) {
  const [agentResolutions, setAgentResolutions] = useState<
    Record<string, ConflictResolutionStrategy>
  >({});
  const [workflowResolutions, setWorkflowResolutions] = useState<
    Record<string, ConflictResolutionStrategy>
  >({});

  const getAgentStrategy = (name: string): ConflictResolutionStrategy =>
    agentResolutions[name] ?? 'skip';
  const getWorkflowStrategy = (name: string): ConflictResolutionStrategy =>
    workflowResolutions[name] ?? 'skip';

  const setAgentStrategy = (name: string, s: ConflictResolutionStrategy) => {
    setAgentResolutions((prev) => ({ ...prev, [name]: s }));
  };
  const setWorkflowStrategy = (name: string, s: ConflictResolutionStrategy) => {
    setWorkflowResolutions((prev) => ({ ...prev, [name]: s }));
  };

  const newAgents = preview.agents.filter((a) => a.action === 'create').length;
  const newWorkflows = preview.workflows.filter((w) => w.action === 'create').length;
  const conflictAgents = preview.agents.filter((a) => a.action === 'conflict');
  const conflictWorkflows = preview.workflows.filter((w) => w.action === 'conflict');

  const willCreateAgents =
    newAgents + conflictAgents.filter((a) => getAgentStrategy(a.name) !== 'skip').length;
  const willCreateWorkflows =
    newWorkflows + conflictWorkflows.filter((w) => getWorkflowStrategy(w.name) !== 'skip').length;

  const hasValidationErrors = preview.validationErrors.length > 0;

  const handleConfirm = () => {
    const resolution: ImportConflictResolution = {};
    const agentConflictRes: Record<string, ConflictResolutionStrategy> = {};
    for (const agent of conflictAgents) {
      agentConflictRes[agent.name] = getAgentStrategy(agent.name);
    }
    const workflowConflictRes: Record<string, ConflictResolutionStrategy> = {};
    for (const wf of conflictWorkflows) {
      workflowConflictRes[wf.name] = getWorkflowStrategy(wf.name);
    }
    if (Object.keys(agentConflictRes).length) resolution.agents = agentConflictRes;
    if (Object.keys(workflowConflictRes).length) resolution.workflows = workflowConflictRes;
    onConfirm(resolution);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Import Preview" size="lg">
      <div class="space-y-5">
        <div class="text-sm text-gray-400">
          Importing from <span class="text-gray-200 font-medium">{bundle.name}</span>
          {bundle.exportedFrom && (
            <span class="ml-1 text-gray-400 font-mono text-xs">({bundle.exportedFrom})</span>
          )}
        </div>

        {hasValidationErrors && (
          <div class="rounded-lg border border-red-800 bg-red-950/40 p-3 space-y-1" role="alert">
            <p class="text-xs font-semibold text-red-400 mb-1">Validation errors</p>
            {preview.validationErrors.map((err, i) => (
              <p key={i} class="text-xs text-red-300">
                {err}
              </p>
            ))}
          </div>
        )}

        {preview.agents.length > 0 && (
          <section>
            <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Agents ({preview.agents.length})
            </h3>
            <div class="divide-y divide-dark-700">
              {preview.agents.map((item) => (
                <ItemRow
                  key={item.name}
                  item={item}
                  strategy={getAgentStrategy(item.name)}
                  onStrategyChange={(s) => setAgentStrategy(item.name, s)}
                />
              ))}
            </div>
          </section>
        )}

        {preview.workflows.length > 0 && (
          <section>
            <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Workflows ({preview.workflows.length})
            </h3>
            <div class="divide-y divide-dark-700">
              {preview.workflows.map((item) => (
                <ItemRow
                  key={item.name}
                  item={item}
                  strategy={getWorkflowStrategy(item.name)}
                  onStrategyChange={(s) => setWorkflowStrategy(item.name, s)}
                />
              ))}
            </div>
          </section>
        )}

        {hasValidationErrors && (
          <div class="rounded-lg border border-yellow-800 bg-yellow-950/30 p-3">
            <p class="text-xs text-yellow-300">
              Workflows with unresolved agent references cannot be imported. Ensure all referenced
              agents are included in the bundle or already exist in this space.
            </p>
          </div>
        )}

        <div class="flex items-center justify-between pt-2 border-t border-dark-700">
          <p class="text-sm text-gray-400">
            Will import <span class="text-gray-100 font-medium">{willCreateAgents}</span>
            {willCreateAgents === 1 ? ' agent' : ' agents'} and{' '}
            <span class="text-gray-100 font-medium">{willCreateWorkflows}</span>
            {willCreateWorkflows === 1 ? ' workflow' : ' workflows'}
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isExecuting}
              class="px-3 py-1.5 text-sm text-gray-300 hover:text-gray-100 hover:bg-dark-800 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isExecuting || (willCreateAgents === 0 && willCreateWorkflows === 0)}
              class="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isExecuting && (
                <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  />
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              )}
              Import
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
