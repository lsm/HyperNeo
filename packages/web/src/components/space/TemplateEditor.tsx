import type {
  AgentModelPoolEntry,
  SettingSource,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { Button } from '../ui/Button';
import { AUTONOMY_LABELS, toolPermissionsToolsList } from './agent-page-labels';
import { LineNumberedTextarea } from './LineNumberedTextarea';
import { ModelPoolEditor, type ModelPoolEditorMode } from './ModelPoolEditor';
import { SettingSourcesEditor } from './SettingSourcesEditor';
import { extraToolsOf, withExtraTool, withoutExtraTool } from './template-extra-tools';
import { runTemplateSave } from './template-save-pipeline';
import { TemplateModelFields, type TemplateModelFieldsValue } from './TemplateModelFields';
import { ToolsEditor, type ToolsSelection } from './ToolsEditor';

export function TemplateEditor({
  template,
  onSaved,
  onCancel,
}: {
  template: SpaceLongHorizonAgentTemplate | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = !!template;
  const templateTools = template ? toolPermissionsToolsList(template) : [];
  const [displayName, setDisplayName] = useState(template?.displayName ?? '');
  const [key, setKey] = useState(template?.key ?? '');
  const [handle, setHandle] = useState(template?.handle ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [instructions, setInstructions] = useState(template?.instructions ?? '');
  const [autonomyLevel, setAutonomyLevel] = useState<number>(template?.suggestedAutonomyLevel ?? 2);
  const [toolsSelection, setToolsSelection] = useState<ToolsSelection>({
    tools: templateTools,
    toolsOverridden: templateTools.length > 0,
  });
  const [modelFields, setModelFields] = useState<TemplateModelFieldsValue>({
    model: template?.model ?? null,
    provider: template?.provider ?? null,
    thinkingLevel: template?.thinkingLevel ?? null,
  });
  const [settingSources, setSettingSources] = useState<SettingSource[] | null>(
    template?.settingSources ?? null
  );
  const [modelPool, setModelPool] = useState<AgentModelPoolEntry[]>(template?.modelPool ?? []);
  const initialModelMode: ModelPoolEditorMode =
    (template?.modelPool ?? []).length > 0 ? 'pool' : 'single';
  const [modelMode, setModelMode] = useState<ModelPoolEditorMode>(initialModelMode);
  const [poolEdited, setPoolEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraToolDraft, setExtraToolDraft] = useState('');
  const extraTools = extraToolsOf(toolsSelection.tools);

  const removeExtraTool = (tool: string) => {
    setToolsSelection((selection) => withoutExtraTool(selection, tool));
  };

  const addExtraTool = () => {
    const entry = extraToolDraft.trim();
    if (!entry) return;
    setToolsSelection((selection) => withExtraTool(selection, entry));
    setExtraToolDraft('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await runTemplateSave({
        template,
        parsedTools: [],
        form: {
          displayName,
          key,
          handle,
          description,
          instructions,
          suggestedAutonomyLevel: autonomyLevel,
          tools: toolsSelection.tools,
          pendingTool: extraToolDraft,
          model: modelFields.model,
          provider: modelFields.provider,
          modelMode,
          initialModelMode,
          poolEdited,
          modelPool,
          thinkingLevel: modelFields.thinkingLevel,
          settingSources,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    'w-full rounded-xl border border-line bg-surface-overlay/90 px-4 py-3 text-sm text-fg placeholder-gray-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10';

  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-scrim p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <div class="relative isolate max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-hidden rounded-t-3xl border border-line bg-surface/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_28px_90px_rgba(0,0,0,0.55)] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(circle_at_4%_0%,rgba(145,77,108,0.22),transparent_34%),radial-gradient(circle_at_100%_6%,rgba(42,94,125,0.18),transparent_38%)] sm:rounded-3xl">
        <div class="flex items-start justify-between border-b border-line px-5 py-5 sm:px-7">
          <div>
            <p class="text-xl font-semibold tracking-tight text-fg">
              {isEdit ? 'Edit template' : 'New template'}
            </p>
            <p class="mt-1 text-sm text-fg-muted">
              {isEdit
                ? 'Update this reusable role preset for agents in this space.'
                : 'Create a reusable role preset for agents in this space.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close template editor"
            class="rounded-xl border border-transparent p-2 text-fg-muted transition-colors hover:border-line hover:bg-fill-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
          >
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="max-h-[calc(100dvh-11rem)] space-y-5 overflow-y-auto px-5 py-5 scrollbar-dark sm:px-7 sm:py-6">
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Name</label>
              <input
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                class={fieldClass}
                placeholder="e.g. Release Readiness"
              />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Template key</label>
              <input
                value={key}
                disabled={isEdit}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
                class={`${fieldClass} disabled:opacity-50`}
                placeholder="e.g. release-readiness.custom"
              />
            </div>
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Default agent handle</label>
            <input
              value={handle}
              onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
              class={fieldClass}
              placeholder="e.g. release-readiness"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Description</label>
            <input
              value={description}
              onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
              class={fieldClass}
              placeholder="A concise summary shown on the template card"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Instructions</label>
            <LineNumberedTextarea
              value={instructions}
              onChange={setInstructions}
              rows={5}
              placeholder="What should agents created from this template do?"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Suggested autonomy</label>
            <div class="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setAutonomyLevel(level)}
                  class={`flex-1 rounded-xl border py-2.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 ${autonomyLevel === level ? 'border-warning/40 bg-warning text-on-warning' : 'border-line bg-surface-overlay/85 text-fg-muted hover:border-line hover:text-fg-soft'}`}
                >
                  {level}
                </button>
              ))}
            </div>
            <p class="mt-1.5 text-xs text-fg-muted">{AUTONOMY_LABELS[autonomyLevel]}</p>
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Model</label>
            <ModelPoolEditor
              mode={modelMode}
              model={modelFields.model ?? ''}
              provider={modelFields.provider ?? ''}
              modelPool={modelPool}
              onModeChange={(nextMode) => {
                setModelMode(nextMode);
                if (nextMode === 'pool') {
                  setModelFields((fields) => ({ ...fields, model: null, provider: null }));
                }
              }}
              onModelChange={(nextModel, nextProvider) =>
                setModelFields((fields) => ({
                  ...fields,
                  model: nextModel || null,
                  provider: nextProvider || null,
                }))
              }
              onModelPoolChange={(next) => {
                setModelPool(next);
                setPoolEdited(JSON.stringify(next) !== JSON.stringify(template?.modelPool ?? []));
              }}
            />
          </div>
          <TemplateModelFields value={modelFields} onChange={setModelFields} hideModelSelect />
          <ToolsEditor
            tools={toolsSelection.tools}
            toolsOverridden={toolsSelection.toolsOverridden}
            onChange={setToolsSelection}
          />
          <div data-testid="lh-template-extra-tools" class="mt-3">
            {extraTools.length > 0 && (
              <>
                <p class="mb-1.5 text-xs text-fg-muted">
                  Scoped or custom tool entries on this template:
                </p>
                <div class="mb-2 flex flex-wrap gap-1.5">
                  {extraTools.map((tool) => (
                    <span
                      key={tool}
                      class="flex items-center gap-1 rounded-lg border border-line bg-surface-overlay/90 px-2.5 py-1 text-xs text-fg-soft"
                    >
                      <span class="font-mono">{tool}</span>
                      <button
                        type="button"
                        onClick={() => removeExtraTool(tool)}
                        aria-label={`Remove ${tool}`}
                        class="rounded p-0.5 text-fg-faint transition-colors hover:bg-fill-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}
            <div class="flex items-center gap-2">
              <input
                type="text"
                value={extraToolDraft}
                onInput={(e) => setExtraToolDraft((e.target as HTMLInputElement).value)}
                class="w-full rounded-xl border border-line bg-surface-overlay/90 px-3 py-2 text-xs text-fg placeholder:text-fg-faint shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10"
                placeholder="Add scoped tool entry, e.g. Bash(gh pr view:*)"
                data-testid="lh-template-extra-tool-input"
              />
              <button
                type="button"
                onClick={addExtraTool}
                class="flex-shrink-0 rounded-xl border border-line px-3 py-2 text-xs text-fg-soft transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
              >
                Add
              </button>
            </div>
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Setting sources</label>
            <SettingSourcesEditor value={settingSources} onChange={setSettingSources} />
            {settingSources === null ? (
              <p class="mt-1 text-xs text-fg-muted">Inherits the space setting sources.</p>
            ) : (
              <button
                type="button"
                onClick={() => setSettingSources(null)}
                class="mt-1 text-xs font-medium text-accent-soft/85 underline-offset-4 transition-colors hover:text-accent-soft hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                Clear override — inherit from space
              </button>
            )}
          </div>
          {error && <p class="text-xs text-danger">{error}</p>}
        </div>
        <div class="flex justify-end gap-3 border-t border-line bg-scrim-soft px-5 py-4 sm:px-7">
          <Button variant="ghost" size="md" onClick={onCancel} class="rounded-xl px-5">
            Cancel
          </Button>
          <Button
            size="md"
            onClick={handleSave}
            disabled={saving}
            class="rounded-xl bg-warning px-6 font-semibold text-on-warning"
          >
            {saving
              ? isEdit
                ? 'Saving…'
                : 'Creating…'
              : isEdit
                ? 'Save changes'
                : 'Create template'}
          </Button>
        </div>
      </div>
    </div>
  );
}
