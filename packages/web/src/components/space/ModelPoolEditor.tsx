import type { AgentModelPoolEntry } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import {
  WorkflowModelSelect,
  type WorkflowModelSelection,
} from './visual-editor/WorkflowModelSelect';

export type ModelPoolEditorMode = 'single' | 'pool';

type NumericDraftField = 'max' | 'weight';

interface NumericDraft {
  index: number;
  field: NumericDraftField;
  text: string;
}

export interface ModelPoolEditorProps {
  mode: ModelPoolEditorMode;
  model: string;
  provider: string;
  modelPool: AgentModelPoolEntry[];
  error?: string;
  onModeChange: (mode: ModelPoolEditorMode) => void;
  onModelChange: (model: string, provider: string) => void;
  onModelPoolChange: (modelPool: AgentModelPoolEntry[]) => void;
}

function newPoolEntry(): AgentModelPoolEntry {
  return { model: '', maxConcurrent: 1, weight: 100 };
}

export function ModelPoolEditor({
  mode,
  model,
  provider,
  modelPool,
  error,
  onModeChange,
  onModelChange,
  onModelPoolChange,
}: ModelPoolEditorProps) {
  const [draft, setDraft] = useState<NumericDraft | null>(null);

  const updateEntry = (index: number, patch: Partial<AgentModelPoolEntry>) => {
    onModelPoolChange(
      modelPool.map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate))
    );
  };

  const draftValue = (index: number, field: NumericDraftField, retained: number) =>
    draft?.index === index && draft.field === field ? draft.text : String(retained);

  const editNumeric = (index: number, field: NumericDraftField, text: string) => {
    setDraft({ index, field, text });
    const val = Number(text);
    if (text === '' || !Number.isFinite(val)) return;
    if (field === 'max') {
      if (val >= 1) updateEntry(index, { maxConcurrent: Math.floor(val) });
    } else if (val >= 0) {
      updateEntry(index, { weight: val });
    }
  };

  const commitNumeric = (index: number, field: NumericDraftField) => {
    setDraft((prev) => (prev?.index === index && prev.field === field ? null : prev));
  };

  return (
    <>
      <div class="flex gap-1.5 mb-2">
        <button
          type="button"
          data-testid="agent-model-mode-single"
          onClick={() => {
            setDraft(null);
            onModeChange('single');
          }}
          class={`text-xs px-2.5 py-1 rounded border transition-colors ${
            mode === 'single'
              ? 'border-accent-hover bg-accent/20 text-accent-soft'
              : 'border-line-strong text-fg-muted hover:border-line-strong hover:text-fg-soft'
          }`}
        >
          Single model
        </button>
        <button
          type="button"
          data-testid="agent-model-mode-pool"
          onClick={() => {
            setDraft(null);
            onModeChange('pool');
            if (modelPool.length === 0) {
              onModelPoolChange([newPoolEntry()]);
            }
          }}
          class={`text-xs px-2.5 py-1 rounded border transition-colors ${
            mode === 'pool'
              ? 'border-accent-hover bg-accent/20 text-accent-soft'
              : 'border-line-strong text-fg-muted hover:border-line-strong hover:text-fg-soft'
          }`}
        >
          Model pool
        </button>
      </div>
      {mode === 'single' ? (
        <>
          <WorkflowModelSelect
            value={model || undefined}
            provider={provider || undefined}
            onChange={(value, selection?: WorkflowModelSelection) => {
              onModelChange(value ?? '', selection?.provider ?? '');
            }}
            testId="space-agent-model-select"
            className={`w-full bg-surface-raised border rounded-lg px-4 py-2.5 text-fg focus:outline-none focus:border-accent font-mono text-sm ${
              error ? 'border-danger' : 'border-line-strong'
            }`}
          />
          {error && <p class="mt-1 text-xs text-danger">{error}</p>}
          <p class="mt-1.5 text-xs text-fg-faint leading-snug">
            Leave empty to use the space default model.
          </p>
        </>
      ) : (
        <div data-testid="agent-model-pool">
          <div class="flex items-center justify-end mb-2">
            <button
              type="button"
              data-testid="pool-add-model-button"
              onClick={() => onModelPoolChange([...modelPool, newPoolEntry()])}
              class="text-xs text-accent hover:text-accent-soft transition-colors"
            >
              + Add model
            </button>
          </div>
          {modelPool.length === 0 ? (
            <p class="text-xs text-fg-faint leading-snug">
              No pool models — this agent uses the space default until one is added.
            </p>
          ) : (
            <div class="space-y-2">
              {modelPool.map((entry, index) => (
                <div
                  key={index}
                  class="flex items-center gap-2 rounded-lg border border-line-strong bg-surface-raised px-3 py-2"
                  data-testid="pool-entry"
                >
                  <WorkflowModelSelect
                    value={entry.model || undefined}
                    provider={entry.provider || undefined}
                    onChange={(value, selection?: WorkflowModelSelection) =>
                      updateEntry(index, {
                        model: value ?? '',
                        provider: selection?.provider ?? undefined,
                      })
                    }
                    testId="pool-entry-model-select"
                    className="flex-1 min-w-0 bg-surface border border-line-strong rounded px-2.5 py-1.5 text-fg focus:outline-none focus:border-accent font-mono text-sm"
                  />
                  <label class="flex items-center gap-1 text-xs text-fg-muted flex-shrink-0">
                    Max
                    <input
                      type="number"
                      min={1}
                      step="any"
                      required
                      data-testid="pool-entry-max-input"
                      value={draftValue(index, 'max', entry.maxConcurrent)}
                      onInput={(e) =>
                        editNumeric(index, 'max', (e.target as HTMLInputElement).value)
                      }
                      onBlur={() => commitNumeric(index, 'max')}
                      class="w-16 appearance-none bg-surface border border-line-strong rounded px-2 py-1 text-fg font-mono text-sm focus:outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </label>
                  <label class="flex items-center gap-1 text-xs text-fg-muted flex-shrink-0">
                    Wt
                    <input
                      type="number"
                      min={0}
                      step="any"
                      required
                      data-testid="pool-entry-weight-input"
                      value={draftValue(index, 'weight', entry.weight)}
                      onInput={(e) =>
                        editNumeric(index, 'weight', (e.target as HTMLInputElement).value)
                      }
                      onBlur={() => commitNumeric(index, 'weight')}
                      class="w-16 appearance-none bg-surface border border-line-strong rounded px-2 py-1 text-fg font-mono text-sm focus:outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </label>
                  <button
                    type="button"
                    data-testid="pool-entry-remove-button"
                    onClick={() => {
                      setDraft(null);
                      onModelPoolChange(modelPool.filter((_, i) => i !== index));
                    }}
                    class="text-fg-muted hover:text-danger transition-colors flex-shrink-0"
                    title="Remove pool entry"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              ))}
              <p class="text-xs text-fg-faint leading-snug">
                Max is the per-model concurrency cap across the space (1 or more) — any
                agent&rsquo;s runs of the same model count toward it. Weight is 0 or more and
                controls this model&rsquo;s share of the remaining capacity (higher = preferred);
                the pool needs at least one positive-weight entry. Each spawn picks by remaining
                capacity × weight; when every model is at its cap the spawn waits. A model pinned on
                a workflow slot or task override bypasses the pool.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
