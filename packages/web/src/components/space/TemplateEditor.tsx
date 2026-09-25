import type {
  AgentModelPoolEntry,
  SettingSource,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { FORM_CONTROL_CLASS, FormActions, FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { AUTONOMY_LABELS, toolPermissionsToolsList } from './agent-page-labels';
import { poolFromModelConfig, withoutInheritedThinkingLevel } from './agent-model-pool';
import { LineNumberedTextarea } from './LineNumberedTextarea';
import { ModelPoolEditor } from './ModelPoolEditor';
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
  const [modelPool, setModelPool] = useState<AgentModelPoolEntry[]>(() =>
    poolFromModelConfig(withoutInheritedThinkingLevel(template))
  );
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

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={isEdit ? 'Edit template' : 'New template'}
      size="lg"
      footer={
        <FormActions
          error={error}
          onCancel={onCancel}
          submitLabel={isEdit ? 'Save changes' : 'Create template'}
          submitting={saving}
          onSubmit={handleSave}
        />
      }
    >
      <div class="space-y-4">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Name">
            <input
              value={displayName}
              onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              class={FORM_CONTROL_CLASS}
              placeholder="e.g. Release Readiness"
            />
          </FormField>
          <FormField label="Template key">
            <input
              value={key}
              disabled={isEdit}
              onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              class={FORM_CONTROL_CLASS}
              placeholder="e.g. release-readiness.custom"
            />
          </FormField>
        </div>
        <FormField label="Default agent handle">
          <input
            value={handle}
            onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
            class={FORM_CONTROL_CLASS}
            placeholder="e.g. release-readiness"
          />
        </FormField>
        <FormField label="Description">
          <input
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
            class={FORM_CONTROL_CLASS}
            placeholder="A concise summary shown on the template card"
          />
        </FormField>
        <FormField label="Instructions">
          <LineNumberedTextarea
            value={instructions}
            onChange={setInstructions}
            rows={5}
            placeholder="What should agents created from this template do?"
          />
        </FormField>
        <FormField label="Suggested autonomy">
          <div class="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setAutonomyLevel(level)}
                class={`flex-1 rounded border py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${autonomyLevel === level ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg-soft'}`}
              >
                {level}
              </button>
            ))}
          </div>
          <p class="mt-1.5 text-xs text-fg-muted">{AUTONOMY_LABELS[autonomyLevel]}</p>
        </FormField>
        <FormField label="Model">
          <ModelPoolEditor
            modelPool={modelPool}
            emptyHint="No models — agents from this template use the space default until one is added."
            onModelPoolChange={setModelPool}
          />
        </FormField>
        <TemplateModelFields value={modelFields} onChange={setModelFields} hideModelSelect />
        <ToolsEditor
          tools={toolsSelection.tools}
          toolsOverridden={toolsSelection.toolsOverridden}
          onChange={setToolsSelection}
        />
        <div data-testid="lh-template-extra-tools">
          {extraTools.length > 0 && (
            <>
              <p class="mb-1.5 text-xs text-fg-muted">
                Scoped or custom tool entries on this template:
              </p>
              <div class="mb-2 flex flex-wrap gap-1.5">
                {extraTools.map((tool) => (
                  <span
                    key={tool}
                    class="flex items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 text-xs text-fg-soft"
                  >
                    <span class="font-mono">{tool}</span>
                    <button
                      type="button"
                      onClick={() => removeExtraTool(tool)}
                      aria-label={`Remove ${tool}`}
                      class="rounded p-0.5 text-fg-faint transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
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
              class={`${FORM_CONTROL_CLASS} font-mono text-xs`}
              placeholder="Add scoped tool entry, e.g. Bash(gh pr view:*)"
              data-testid="lh-template-extra-tool-input"
            />
            <button
              type="button"
              onClick={addExtraTool}
              class="flex-shrink-0 rounded border border-line px-2.5 py-1.5 text-xs text-fg-soft transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              Add
            </button>
          </div>
        </div>
        <FormField label="Setting sources">
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
        </FormField>
      </div>
    </Modal>
  );
}
