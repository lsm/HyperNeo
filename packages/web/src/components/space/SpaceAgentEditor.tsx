import type {
  SettingSource,
  SpaceWorkerAgent,
  SpaceWorkerAgentPromotionDraft,
  ThinkingLevel,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import { DENIABLE_TOOLS, KNOWN_TOOLS, normalizeThinkingLevel } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import type { SpaceWorkerAgentTemplate } from '../../lib/space-store';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import {
  WorkflowModelSelect,
  type WorkflowModelSelection,
} from './visual-editor/WorkflowModelSelect';

type ToolName = (typeof KNOWN_TOOLS)[number];

const TOOL_PRESETS: Record<string, ToolName[]> = {
  'Read Only': ['Read', 'Grep', 'Glob'],
};
const TOOL_PRESET_BUTTONS = ['Inherit defaults', ...Object.keys(TOOL_PRESETS), 'Custom'];
const DENIABLE_TOOL_SET = new Set<string>(DENIABLE_TOOLS);

const THINKING_LEVEL_OPTIONS: Array<{ value: '' | ThinkingLevel; label: string }> = [
  { value: '', label: 'Use app default' },
  { value: 'off', label: 'Off' },
  { value: 'think8k', label: 'Think 8k' },
  { value: 'think16k', label: 'Think 16k' },
  { value: 'think24k', label: 'Think 24k' },
  { value: 'think32k', label: 'Think 32k' },
];

function detectPreset(toolList: string[] | null | undefined): string {
  if (toolList == null || toolList.length === 0) return 'Inherited';
  for (const [preset, presetTools] of Object.entries(TOOL_PRESETS)) {
    if (toolList.length === presetTools.length && presetTools.every((t) => toolList.includes(t))) {
      return preset;
    }
  }
  return 'Custom';
}

interface LineNumberedTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

function LineNumberedTextarea({
  value,
  onChange,
  placeholder,
  rows = 10,
}: LineNumberedTextareaProps) {
  const lineCount = value ? value.split('\n').length : 1;
  const displayLines = Math.max(lineCount, rows);

  return (
    <div class="relative flex border border-line-strong rounded-lg overflow-hidden bg-surface-raised focus-within:border-accent transition-colors">
      <div
        aria-hidden="true"
        class="flex flex-col items-end px-2 py-2 select-none text-fg-muted text-xs font-mono bg-surface-overlay border-r border-line flex-shrink-0"
        style="min-width: 2.5rem; line-height: 1.375rem;"
      >
        {Array.from({ length: displayLines }, (_, i) => (
          <span key={i} style="height: 1.375rem; line-height: 1.375rem;">
            {i + 1}
          </span>
        ))}
      </div>
      <textarea
        value={value}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        placeholder={placeholder}
        rows={rows}
        spellcheck={false}
        class="flex-1 bg-transparent py-2 px-3 text-fg font-mono text-xs resize-none focus:outline-none"
        style="line-height: 1.375rem;"
      />
    </div>
  );
}

export interface SpaceAgentEditorProps {
  agent: SpaceWorkerAgent | null;
  promotionDraft?: SpaceWorkerAgentPromotionDraft | null;
  existingAgentNames: string[];
  onSave: () => void;
  onCancel: () => void;
}

export function SpaceAgentEditor({
  agent,
  promotionDraft,
  existingAgentNames,
  onSave,
  onCancel,
}: SpaceAgentEditorProps) {
  const isEdit = agent !== null;
  const isPromotion = !isEdit && promotionDraft !== null && promotionDraft !== undefined;
  const builtInTemplates = spaceStore.agentTemplates.value;

  const [name, setName] = useState(agent?.name ?? promotionDraft?.name ?? '');
  const [description, setDescription] = useState(
    agent?.description ?? promotionDraft?.description ?? ''
  );
  const [model, setModel] = useState(agent?.model ?? promotionDraft?.model ?? '');
  const [provider, setProvider] = useState(agent?.provider ?? promotionDraft?.provider ?? '');
  const [modelPool, setModelPool] = useState<WorkerAgentModelPoolEntry[]>(agent?.modelPool ?? []);
  const [modelMode, setModelMode] = useState<'single' | 'pool'>(
    (agent?.modelPool?.length ?? 0) > 0 ? 'pool' : 'single'
  );
  const [thinkingLevel, setThinkingLevel] = useState<'' | ThinkingLevel>(
    agent?.thinkingLevel
      ? normalizeThinkingLevel(agent.thinkingLevel)
      : promotionDraft?.thinkingLevel
        ? normalizeThinkingLevel(promotionDraft.thinkingLevel)
        : ''
  );
  const initialTools = agent?.tools ?? promotionDraft?.tools ?? [];
  const initialToolsOverridden = initialTools.length > 0;
  const [tools, setTools] = useState<string[]>(initialTools);
  const [toolsOverridden, setToolsOverridden] = useState(initialToolsOverridden);
  const [customPrompt, setCustomPrompt] = useState(
    agent?.customPrompt ?? promotionDraft?.customPrompt ?? ''
  );
  const inheritedSettingSources = spaceStore.space?.value?.settingSources ?? [
    'user',
    'project',
    'local',
  ];
  const [settingSources, setSettingSources] = useState<SettingSource[]>(
    agent?.settingSources ?? promotionDraft?.settingSources ?? inheritedSettingSources
  );
  const [activePreset, setActivePreset] = useState<string>(() =>
    detectPreset(agent?.tools ?? promotionDraft?.tools)
  );
  const [selectedTemplateName, setSelectedTemplateName] = useState<string>('');
  const [selectedTemplateHash, setSelectedTemplateHash] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearSettingSources, setClearSettingSources] = useState(false);

  const applyPreset = (presetName: string) => {
    setActivePreset(presetName);
    if (presetName in TOOL_PRESETS) {
      const presetTools = TOOL_PRESETS[presetName];
      if (presetTools.length === 0) {
        setToolsOverridden(false);
        setActivePreset('Inherited');
        setTools([]);
      } else {
        setToolsOverridden(true);
        setTools([...presetTools]);
      }
    }
  };

  const inheritTools = () => {
    setToolsOverridden(false);
    setActivePreset('Inherited');
    setTools([]);
  };

  const startCustom = () => {
    setToolsOverridden(true);
    setActivePreset('Custom');
    setTools([...(KNOWN_TOOLS as readonly string[])]);
  };

  const applyTemplate = (template: SpaceWorkerAgentTemplate) => {
    if (!isEdit && !name.trim()) {
      setName(template.name);
    }
    setDescription(template.description ?? '');
    setCustomPrompt(template.customPrompt ?? '');
    setTools([...template.tools]);
    setToolsOverridden(template.tools.length > 0);
    setSelectedTemplateHash(template.templateHash ?? null);
    setActivePreset(detectPreset(template.tools));
    setErrors((prev) => ({ ...prev, tools: '', name: '', model: '' }));
    setSaveError(null);
  };

  const matchingPreset = isEdit
    ? (builtInTemplates.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase()) ??
      null)
    : null;

  const resetToPreset = () => {
    if (!matchingPreset) return;
    setSelectedTemplateName(matchingPreset.name);
    applyTemplate(matchingPreset);
  };

  const toggleTool = (tool: string) => {
    setTools((prev) => {
      const next = prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool];
      if (next.length === 0) {
        setToolsOverridden(false);
        setActivePreset('Inherited');
      } else {
        setToolsOverridden(true);
        setActivePreset(detectPreset(next));
      }
      return next;
    });
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    const trimmedName = name.trim();
    if (!trimmedName) {
      newErrors['name'] = 'Name is required';
    } else {
      const lower = trimmedName.toLowerCase();
      const conflict = existingAgentNames.some((n) => n.toLowerCase() === lower);
      if (conflict) {
        newErrors['name'] = 'An agent with this name already exists';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    setSaveError(null);

    try {
      const trimmedDescription = description.trim();
      const effectiveModel = modelMode === 'single' ? model.trim() : '';
      const cleanedModelPool = modelPool
        .map((entry) => ({ ...entry, model: entry.model.trim() }))
        .filter((entry) => entry.model.length > 0);
      const activeModelPool =
        modelMode === 'pool' && cleanedModelPool.length > 0 ? cleanedModelPool : null;
      const providerChanged = provider !== (agent?.provider ?? '');
      const selectedTemplate = builtInTemplates.find((item) => item.name === selectedTemplateName);
      const selectedTemplateStillMatches =
        selectedTemplate &&
        trimmedDescription === (selectedTemplate.description ?? '') &&
        customPrompt === (selectedTemplate.customPrompt ?? '') &&
        JSON.stringify(tools) === JSON.stringify(selectedTemplate.tools);
      const templateTracked = agent?.templateName || agent?.templateHash;
      const agentHasExplicitToolProfile = (agent?.tools?.length ?? 0) > 0;
      const explicitToolsCleared = isEdit && !toolsOverridden && agentHasExplicitToolProfile;
      const templateFieldsChanged =
        isEdit &&
        templateTracked &&
        (trimmedDescription !== (agent.description ?? '') ||
          customPrompt !== (agent.customPrompt ?? '') ||
          explicitToolsCleared ||
          (toolsOverridden && JSON.stringify(tools) !== JSON.stringify(agent.tools ?? [])));
      const editReattachPreset = isEdit && selectedTemplateStillMatches ? selectedTemplate : null;
      const baseParams = {
        name: name.trim(),
        description: trimmedDescription || (isEdit ? null : undefined),
        ...(effectiveModel ? { model: effectiveModel, provider: provider || undefined } : {}),
        ...(isEdit && !effectiveModel && (agent?.model || agent?.provider)
          ? { model: null, provider: null }
          : {}),
        ...(isEdit && effectiveModel && providerChanged && !provider ? { provider: null } : {}),
        customPrompt: customPrompt || null,
        ...(toolsOverridden
          ? { tools }
          : isEdit && agentHasExplicitToolProfile
            ? { tools: null }
            : !isEdit
              ? { tools: [] }
              : {}),
        ...(clearSettingSources ||
        JSON.stringify(settingSources) !==
          JSON.stringify(agent?.settingSources ?? inheritedSettingSources)
          ? { settingSources: clearSettingSources ? null : settingSources }
          : {}),
        ...(isEdit && editReattachPreset
          ? {
              templateName: editReattachPreset.name,
              templateHash: editReattachPreset.templateHash ?? null,
            }
          : templateFieldsChanged
            ? { templateName: null, templateHash: null }
            : {}),
        modelPool: activeModelPool,
      };

      if (isEdit && agent) {
        await spaceStore.updateAgent(agent.id, {
          ...baseParams,
          thinkingLevel: thinkingLevel || null,
        });
      } else {
        const createParams = {
          name: name.trim(),
          description: trimmedDescription || undefined,
          customPrompt: customPrompt || null,
          tools: toolsOverridden ? tools : [],
          modelPool: activeModelPool ?? undefined,
          ...(effectiveModel ? { model: effectiveModel, provider: provider || undefined } : {}),
          ...(clearSettingSources ||
          JSON.stringify(settingSources) !== JSON.stringify(inheritedSettingSources)
            ? { settingSources: clearSettingSources ? null : settingSources }
            : {}),
          ...(selectedTemplateName && selectedTemplateStillMatches
            ? { templateName: selectedTemplateName, templateHash: selectedTemplateHash }
            : {}),
        };
        if (promotionDraft) {
          await spaceStore.promoteSessionToAgent(promotionDraft.sourceSessionId, {
            ...createParams,
            thinkingLevel: thinkingLevel || undefined,
          });
        } else {
          await spaceStore.createAgent({
            ...createParams,
            thinkingLevel: thinkingLevel || undefined,
          });
        }
      }

      onSave();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit
    ? `Edit Agent: ${agent!.name}`
    : isPromotion
      ? `Promote Session: ${promotionDraft!.sourceSessionTitle}`
      : 'Create Agent';

  return (
    <Modal isOpen onClose={onCancel} title={title} size="lg">
      <form onSubmit={handleSubmit} class="space-y-5">
        {saveError && (
          <div class="bg-danger/20 border border-danger rounded-lg px-4 py-3 text-danger text-sm">
            {saveError}
          </div>
        )}

        {isPromotion && promotionDraft && (
          <div class="rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-soft">
            <p class="font-medium">Review generated long-horizon profile before creating agent.</p>
            <p class="mt-1 text-xs text-accent-soft/80">
              Draft uses recent renderable messages from "{promotionDraft.sourceSessionTitle}" as
              standing context instead of copying raw chat history.
            </p>
          </div>
        )}

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1.5" for="agent-template-select">
            From Template
          </label>
          <select
            id="agent-template-select"
            value={selectedTemplateName}
            onChange={(e) => {
              const templateName = (e.target as HTMLSelectElement).value;
              setSelectedTemplateName(templateName);
              const template = builtInTemplates.find((item) => item.name === templateName);
              if (template) applyTemplate(template);
            }}
            class="w-full bg-surface-raised border border-line-strong rounded-lg px-4 py-2.5 text-fg focus:outline-none focus:border-accent"
          >
            <option value="">Select a built-in template...</option>
            {builtInTemplates.map((template) => (
              <option key={template.name} value={template.name}>
                {template.name}
              </option>
            ))}
          </select>
          {builtInTemplates.length === 0 && (
            <p class="mt-1 text-xs text-fg-muted">
              No built-in templates are available for this space.
            </p>
          )}
        </div>

        {isEdit && matchingPreset && (
          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={resetToPreset}
              class="text-xs text-accent hover:text-accent-soft"
              title={`Replace this agent's description, tools, and custom prompt with the current ${matchingPreset.name} preset and re-link it to preset tracking.`}
            >
              Reset to {matchingPreset.name} default
            </button>
            {(!agent?.templateName || !agent?.templateHash) && (
              <span class="text-xs text-warning/80">
                Not linked to preset tracking — reset re-attaches it.
              </span>
            )}
          </div>
        )}

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1.5">
            Name
            <span class="text-danger ml-1">*</span>
          </label>
          <input
            type="text"
            value={name}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
              if (errors['name']) setErrors((prev) => ({ ...prev, name: '' }));
            }}
            placeholder="e.g., Senior Coder"
            class={`w-full bg-surface-raised border rounded-lg px-4 py-2.5 text-fg placeholder-gray-600 focus:outline-none focus:border-accent ${
              errors['name'] ? 'border-danger' : 'border-line-strong'
            }`}
            autoFocus
          />
          {errors['name'] && <p class="mt-1 text-xs text-danger">{errors['name']}</p>}
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1.5">
            Description
            <span class="text-fg-muted text-xs ml-2">(optional)</span>
          </label>
          <input
            type="text"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
            placeholder="Briefly describe this agent's specialization..."
            class="w-full bg-surface-raised border border-line-strong rounded-lg px-4 py-2.5 text-fg placeholder-gray-600 focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1.5">
            Model
            <span class="text-fg-muted text-xs ml-2">(optional)</span>
          </label>
          <div class="flex gap-1.5 mb-2">
            <button
              type="button"
              data-testid="agent-model-mode-single"
              onClick={() => setModelMode('single')}
              class={`text-xs px-2.5 py-1 rounded border transition-colors ${
                modelMode === 'single'
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
                setModelMode('pool');
                if (modelPool.length === 0) {
                  setModelPool([{ model: '', maxConcurrent: 1, weight: 100 }]);
                }
              }}
              class={`text-xs px-2.5 py-1 rounded border transition-colors ${
                modelMode === 'pool'
                  ? 'border-accent-hover bg-accent/20 text-accent-soft'
                  : 'border-line-strong text-fg-muted hover:border-line-strong hover:text-fg-soft'
              }`}
            >
              Model pool
            </button>
          </div>
          {modelMode === 'single' ? (
            <>
              <WorkflowModelSelect
                value={model || undefined}
                provider={provider || undefined}
                onChange={(value, selection?: WorkflowModelSelection) => {
                  setModel(value ?? '');
                  setProvider(selection?.provider ?? '');
                  if (errors['model']) setErrors((prev) => ({ ...prev, model: '' }));
                }}
                testId="space-agent-model-select"
                className={`w-full bg-surface-raised border rounded-lg px-4 py-2.5 text-fg focus:outline-none focus:border-accent font-mono text-sm ${
                  errors['model'] ? 'border-danger' : 'border-line-strong'
                }`}
              />
              {errors['model'] && <p class="mt-1 text-xs text-danger">{errors['model']}</p>}
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
                  onClick={() =>
                    setModelPool((prev) => [...prev, { model: '', maxConcurrent: 1, weight: 100 }])
                  }
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
                          setModelPool((prev) =>
                            prev.map((candidate, i) =>
                              i === index
                                ? {
                                    ...candidate,
                                    model: value ?? '',
                                    provider: selection?.provider ?? undefined,
                                  }
                                : candidate
                            )
                          )
                        }
                        testId="pool-entry-model-select"
                        className="flex-1 min-w-0 bg-surface border border-line-strong rounded px-2.5 py-1.5 text-fg focus:outline-none focus:border-accent font-mono text-sm"
                      />
                      <label class="flex items-center gap-1 text-xs text-fg-muted flex-shrink-0">
                        Max
                        <input
                          type="number"
                          min={1}
                          data-testid="pool-entry-max-input"
                          value={entry.maxConcurrent}
                          onInput={(e) => {
                            const val = Number((e.target as HTMLInputElement).value);
                            if (Number.isFinite(val) && val >= 1) {
                              setModelPool((prev) =>
                                prev.map((candidate, i) =>
                                  i === index
                                    ? { ...candidate, maxConcurrent: Math.floor(val) }
                                    : candidate
                                )
                              );
                            }
                          }}
                          class="w-16 appearance-none bg-surface border border-line-strong rounded px-2 py-1 text-fg font-mono text-sm focus:outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </label>
                      <label class="flex items-center gap-1 text-xs text-fg-muted flex-shrink-0">
                        Wt
                        <input
                          type="number"
                          min={1}
                          max={100}
                          data-testid="pool-entry-weight-input"
                          value={entry.weight}
                          onInput={(e) => {
                            const val = Number((e.target as HTMLInputElement).value);
                            if (Number.isFinite(val) && val >= 1 && val <= 100) {
                              setModelPool((prev) =>
                                prev.map((candidate, i) =>
                                  i === index ? { ...candidate, weight: val } : candidate
                                )
                              );
                            }
                          }}
                          class="w-16 appearance-none bg-surface border border-line-strong rounded px-2 py-1 text-fg font-mono text-sm focus:outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </label>
                      <button
                        type="button"
                        data-testid="pool-entry-remove-button"
                        onClick={() => setModelPool((prev) => prev.filter((_, i) => i !== index))}
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
                    Max is the per-model concurrency cap for this agent in the workspace (1 or
                    more). Weight is 1–100 and controls this model&rsquo;s share of the remaining
                    capacity (higher = preferred). Each spawn picks by remaining capacity × weight;
                    when every model is at its cap the spawn waits. A model pinned on a workflow
                    slot or task override bypasses the pool.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1.5">
            Thinking Level
            <span class="text-fg-muted text-xs ml-2">(optional override)</span>
          </label>
          <select
            value={thinkingLevel}
            onChange={(e) =>
              setThinkingLevel((e.target as HTMLSelectElement).value as '' | ThinkingLevel)
            }
            class="w-full bg-surface-raised border border-line-strong rounded-lg px-4 py-2.5 text-fg focus:outline-none focus:border-accent"
          >
            {THINKING_LEVEL_OPTIONS.map((option) => (
              <option key={option.value || 'default'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1.5">
            Setting Sources
            <span class="text-fg-muted text-xs ml-2">(optional)</span>
          </label>
          {isEdit && agent?.settingSources !== undefined && !clearSettingSources && (
            <button
              type="button"
              onClick={() => setClearSettingSources(true)}
              class="text-xs text-accent hover:text-accent-soft mb-1.5"
            >
              Clear override — use inherited defaults
            </button>
          )}
          {clearSettingSources && (
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-xs text-fg-muted">Will revert to inherited defaults on save.</span>
              <button
                type="button"
                onClick={() => setClearSettingSources(false)}
                class="text-xs text-accent hover:text-accent-soft"
              >
                Cancel
              </button>
            </div>
          )}
          <div class="space-y-1.5">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settingSources.includes('user')}
                onChange={() => {
                  setSettingSources((prev) =>
                    prev.includes('user') ? prev.filter((s) => s !== 'user') : [...prev, 'user']
                  );
                }}
                disabled={clearSettingSources}
                class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
              />
              <span class="text-sm text-fg-soft">User settings</span>
              <span class="text-xs text-fg-muted">(~/.claude/settings.json)</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settingSources.includes('project')}
                onChange={() => {
                  setSettingSources((prev) =>
                    prev.includes('project')
                      ? prev.filter((s) => s !== 'project')
                      : [...prev, 'project']
                  );
                }}
                disabled={clearSettingSources}
                class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
              />
              <span class="text-sm text-fg-soft">Project settings + CLAUDE.md</span>
              <span class="text-xs text-fg-muted">(.claude/settings.json)</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settingSources.includes('local')}
                onChange={() => {
                  setSettingSources((prev) =>
                    prev.includes('local') ? prev.filter((s) => s !== 'local') : [...prev, 'local']
                  );
                }}
                disabled={clearSettingSources}
                class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
              />
              <span class="text-sm text-fg-soft">Local settings</span>
              <span class="text-xs text-fg-muted">(.claude/settings.local.json)</span>
            </label>
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="block text-sm font-medium text-fg-soft">
              Tools
              {!toolsOverridden && <span class="text-fg-muted text-xs ml-2">(inherited)</span>}
            </label>
            <div class="flex gap-1.5">
              {TOOL_PRESET_BUTTONS.map((preset) => {
                const active =
                  preset === 'Inherit defaults'
                    ? !toolsOverridden
                    : activePreset === preset && toolsOverridden;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      if (preset === 'Inherit defaults') inheritTools();
                      else if (preset === 'Custom') startCustom();
                      else applyPreset(preset);
                    }}
                    class={`text-xs px-2.5 py-1 rounded border transition-colors ${
                      active
                        ? 'border-accent-hover bg-accent/20 text-accent-soft'
                        : 'border-line-strong text-fg-muted hover:border-line-strong hover:text-fg-soft'
                    }`}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </div>

          <div class="rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 mb-3 text-sm text-accent-soft">
            <p class="font-medium">SDK defaults are always inherited.</p>
            <p class="mt-1 text-xs text-accent-soft/80">
              {toolsOverridden && tools.length > 0
                ? 'Checked tools are explicit profile entries. Bash, Write, Edit, MultiEdit, and NotebookEdit are denied when unchecked; other unchecked SDK tools remain inherited.'
                : 'This agent inherits all SDK built-in tools. No explicit overrides are set.'}
            </p>
          </div>

          {toolsOverridden && tools.length > 0 && (
            <p class="mb-2 text-xs text-fg-faint">
              Checked = explicit profile entry; unchecked usually still inherited.
            </p>
          )}

          <div class="grid grid-cols-3 gap-1.5">
            {(KNOWN_TOOLS as readonly string[]).map((tool) => {
              const inherited = !toolsOverridden;
              const checked = inherited || tools.includes(tool);
              const denied =
                toolsOverridden && tools.length > 0 && DENIABLE_TOOL_SET.has(tool) && !checked;
              return (
                <label
                  key={tool}
                  class={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs transition-colors ${
                    inherited
                      ? 'border-line-strong bg-surface-raised/40 text-fg-faint cursor-not-allowed'
                      : checked
                        ? 'border-accent/60 bg-accent/15 text-accent-soft cursor-pointer'
                        : denied
                          ? 'border-danger/60 bg-danger/15 text-danger-soft hover:border-red-600 cursor-pointer'
                          : 'border-line text-fg-muted hover:border-line-strong hover:text-fg-soft cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={inherited}
                    onChange={() => !inherited && toggleTool(tool)}
                    class="sr-only"
                  />
                  <span
                    class={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
                      inherited
                        ? 'bg-line-strong border-line-strong'
                        : checked
                          ? 'bg-accent-hover border-accent-hover'
                          : denied
                            ? 'border-danger'
                            : 'border-line-strong'
                    }`}
                  >
                    {checked && (
                      <svg
                        class="w-2.5 h-2.5 text-accent-fg"
                        fill="currentColor"
                        viewBox="0 0 12 12"
                      >
                        <path d="M10 3L5 8.5 2 5.5l-1 1L5 10.5l6-7-1-1z" />
                      </svg>
                    )}
                    {denied && <span class="text-[10px] leading-none text-danger-soft">×</span>}
                  </span>
                  <span>{tool}</span>
                  {denied && (
                    <span class="ml-auto text-[10px] uppercase tracking-wide text-danger-soft">
                      Denied
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {errors['tools'] && <p class="mt-1.5 text-xs text-danger">{errors['tools']}</p>}
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-2">
            {isPromotion ? 'Long-Horizon Profile' : 'Custom Prompt'}
            <span class="text-fg-muted text-xs ml-2">
              (optional — appended after HyperNeo contract)
            </span>
          </label>
          {isPromotion && (
            <p class="mb-2 text-xs text-fg-muted">
              Edit responsibility, standing instructions, autonomy, managed goals/scopes, reminders,
              event subscriptions, and standing context here.
            </p>
          )}
          <LineNumberedTextarea
            value={customPrompt}
            onChange={setCustomPrompt}
            placeholder="Persona, operating procedure, or any additional context for this agent..."
            rows={isPromotion ? 14 : 8}
          />
        </div>

        <div class="flex gap-3 pt-1">
          <Button type="button" variant="secondary" onClick={onCancel} fullWidth>
            Cancel
          </Button>
          <Button type="submit" loading={saving} fullWidth>
            {isEdit ? 'Save Changes' : isPromotion ? 'Create Long-Horizon Agent' : 'Create Agent'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
