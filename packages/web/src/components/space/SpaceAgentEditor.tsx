/**
 * SpaceAgentEditor Component
 *
 * Modal form for creating or editing a worker agent in a Space.
 *
 * Fields:
 * - From Template (built-in seeded templates)
 * - Name (required, unique within space)
 * - Description (optional)
 * - Model (dropdown override, optional for default model inheritance)
 * - Tools (multi-select checkboxes from KNOWN_TOOLS)
 * - Custom Prompt (monospace textarea with line numbers; appended after NeoKai contract)
 *
 * Tool presets: "Full Coding" · "Read Only" · "Custom"
 *
 * Validation: name required + unique, at least one tool selected.
 */

import type {
  SpaceAgent,
  SpaceAgentPromotionDraft,
  ThinkingLevel,
  SettingSource,
} from '@neokai/shared';
import { KNOWN_TOOLS, normalizeThinkingLevel } from '@neokai/shared';
import { useState } from 'preact/hooks';
import type { SpaceAgentTemplate } from '../../lib/space-store';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import {
  WorkflowModelSelect,
  type WorkflowModelSelection,
} from './visual-editor/WorkflowModelSelect';

// ============================================================================
// Constants
// ============================================================================

type ToolName = (typeof KNOWN_TOOLS)[number];

/** Tool presets map preset name → tool selection */
const FULL_CODING_TOOLS: ToolName[] = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
];

const TOOL_PRESETS: Record<string, ToolName[]> = {
  'Full Coding': FULL_CODING_TOOLS,
  'Read Only': ['Read', 'Grep', 'Glob'],
};

const THINKING_LEVEL_OPTIONS: Array<{ value: '' | ThinkingLevel; label: string }> = [
  { value: '', label: 'Use app default' },
  { value: 'off', label: 'Off' },
  { value: 'think8k', label: 'Think 8k' },
  { value: 'think16k', label: 'Think 16k' },
  { value: 'think24k', label: 'Think 24k' },
  { value: 'think32k', label: 'Think 32k' },
];

// ============================================================================
// Pure helpers (module-level to avoid re-creation on each render)
// ============================================================================

/** Detect which preset name matches a given tool list, or 'Custom' if no match */
function detectPreset(toolList: string[] | null | undefined): string {
  if (!toolList) return 'Inherited';
  for (const [preset, presetTools] of Object.entries(TOOL_PRESETS)) {
    if (toolList.length === presetTools.length && presetTools.every((t) => toolList.includes(t))) {
      return preset;
    }
  }
  return 'Custom';
}

// ============================================================================
// Sub-components
// ============================================================================

interface LineNumberedTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

/** Monospace textarea with a line-number gutter on the left */
function LineNumberedTextarea({
  value,
  onChange,
  placeholder,
  rows = 10,
}: LineNumberedTextareaProps) {
  const lineCount = value ? value.split('\n').length : 1;
  const displayLines = Math.max(lineCount, rows);

  return (
    <div class="relative flex border border-dark-600 rounded-lg overflow-hidden bg-dark-800 focus-within:border-blue-500 transition-colors">
      {/* Line numbers gutter */}
      <div
        aria-hidden="true"
        class="flex flex-col items-end px-2 py-2 select-none text-gray-400 text-xs font-mono bg-dark-850 border-r border-dark-700 flex-shrink-0"
        style="min-width: 2.5rem; line-height: 1.375rem;"
      >
        {Array.from({ length: displayLines }, (_, i) => (
          <span key={i} style="height: 1.375rem; line-height: 1.375rem;">
            {i + 1}
          </span>
        ))}
      </div>
      {/* Textarea */}
      <textarea
        value={value}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        placeholder={placeholder}
        rows={rows}
        spellcheck={false}
        class="flex-1 bg-transparent py-2 px-3 text-gray-100 font-mono text-xs resize-none focus:outline-none"
        style="line-height: 1.375rem;"
      />
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

export interface SpaceAgentEditorProps {
  /** Existing agent to edit. Null = create mode. */
  agent: SpaceAgent | null;
  /** Draft generated from an ad-hoc Space session. */
  promotionDraft?: SpaceAgentPromotionDraft | null;
  /** Names of other agents in this space (for uniqueness validation) */
  existingAgentNames: string[];
  /** Called after a successful save */
  onSave: () => void;
  /** Called when the user cancels */
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

  // Form state
  const [name, setName] = useState(agent?.name ?? promotionDraft?.name ?? '');
  const [description, setDescription] = useState(
    agent?.description ?? promotionDraft?.description ?? ''
  );
  const [model, setModel] = useState(agent?.model ?? promotionDraft?.model ?? '');
  const [provider, setProvider] = useState(agent?.provider ?? promotionDraft?.provider ?? '');
  const [thinkingLevel, setThinkingLevel] = useState<'' | ThinkingLevel>(
    agent?.thinkingLevel
      ? normalizeThinkingLevel(agent.thinkingLevel)
      : promotionDraft?.thinkingLevel
        ? normalizeThinkingLevel(promotionDraft.thinkingLevel)
        : ''
  );
  const [tools, setTools] = useState<string[]>(
    agent?.tools ?? promotionDraft?.tools ?? [...TOOL_PRESETS['Full Coding']]
  );
  const [toolsOverridden, setToolsOverridden] = useState(
    agent?.tools !== undefined || promotionDraft?.tools !== undefined || !isEdit
  );
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

  // UI state
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearSettingSources, setClearSettingSources] = useState(false);

  const applyPreset = (presetName: string) => {
    setActivePreset(presetName);
    if (presetName in TOOL_PRESETS) {
      setToolsOverridden(true);
      setTools([...TOOL_PRESETS[presetName]]);
    }
  };

  const applyTemplate = (template: SpaceAgentTemplate) => {
    if (!isEdit && !name.trim()) {
      setName(template.name);
    }
    setDescription(template.description ?? '');
    setCustomPrompt(template.customPrompt ?? '');
    setTools([...template.tools]);
    setToolsOverridden(true);
    setSelectedTemplateHash(template.templateHash ?? null);
    setActivePreset(detectPreset(template.tools));
    setErrors((prev) => ({ ...prev, tools: '', name: '', model: '' }));
    setSaveError(null);
  };

  const toggleTool = (tool: string) => {
    setToolsOverridden(true);
    setTools((prev) => {
      const next = prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool];
      setActivePreset(detectPreset(next));
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

    if (toolsOverridden && tools.length === 0) {
      newErrors['tools'] = 'At least one tool must be selected';
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
      const trimmedModel = model.trim();
      const providerChanged = provider !== (agent?.provider ?? '');
      const selectedTemplate = builtInTemplates.find((item) => item.name === selectedTemplateName);
      const selectedTemplateStillMatches =
        selectedTemplate &&
        trimmedDescription === (selectedTemplate.description ?? '') &&
        customPrompt === (selectedTemplate.customPrompt ?? '') &&
        JSON.stringify(tools) === JSON.stringify(selectedTemplate.tools);
      const templateTracked = agent?.templateName || agent?.templateHash;
      const explicitToolsCleared = isEdit && !toolsOverridden && agent?.tools !== undefined;
      const templateFieldsChanged =
        isEdit &&
        templateTracked &&
        (trimmedDescription !== (agent.description ?? '') ||
          customPrompt !== (agent.customPrompt ?? '') ||
          explicitToolsCleared ||
          (toolsOverridden && JSON.stringify(tools) !== JSON.stringify(agent.tools ?? [])));
      const baseParams = {
        name: name.trim(),
        description: trimmedDescription || (isEdit ? null : undefined),
        ...(trimmedModel ? { model: trimmedModel, provider: provider || undefined } : {}),
        ...(isEdit && !trimmedModel && (agent?.model || agent?.provider)
          ? { model: null, provider: null }
          : {}),
        ...(isEdit && trimmedModel && providerChanged && !provider ? { provider: null } : {}),
        customPrompt: customPrompt || null,
        ...(toolsOverridden
          ? { tools: tools.length > 0 ? tools : null }
          : isEdit && agent?.tools !== undefined
            ? { tools: null }
            : {}),
        ...(clearSettingSources ||
        JSON.stringify(settingSources) !==
          JSON.stringify(agent?.settingSources ?? inheritedSettingSources)
          ? { settingSources: clearSettingSources ? null : settingSources }
          : {}),
        ...(templateFieldsChanged ? { templateName: null, templateHash: null } : {}),
      };

      if (isEdit && agent) {
        await spaceStore.updateAgent(agent.id, {
          ...baseParams,
          thinkingLevel: thinkingLevel || null,
        });
      } else {
        const {
          tools: _editTools,
          templateName: _templateName,
          templateHash: _templateHash,
          model: _editModel,
          provider: _editProvider,
          ...createBaseParams
        } = baseParams;
        const createParams = {
          ...createBaseParams,
          ...(toolsOverridden ? { tools } : {}),
          description: trimmedDescription || undefined,
          ...(trimmedModel ? { model: trimmedModel, provider: provider || undefined } : {}),
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
        {/* Save error */}
        {saveError && (
          <div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
            {saveError}
          </div>
        )}

        {isPromotion && promotionDraft && (
          <div class="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
            <p class="font-medium">Review generated long-horizon profile before creating agent.</p>
            <p class="mt-1 text-xs text-blue-200/80">
              Draft uses recent renderable messages from "{promotionDraft.sourceSessionTitle}" as
              standing context instead of copying raw chat history.
            </p>
          </div>
        )}

        {/* Template selector */}
        <div>
          <label class="block text-sm font-medium text-gray-200 mb-1.5" for="agent-template-select">
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
            class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500"
          >
            <option value="">Select a built-in template...</option>
            {builtInTemplates.map((template) => (
              <option key={template.name} value={template.name}>
                {template.name}
              </option>
            ))}
          </select>
          {builtInTemplates.length === 0 && (
            <p class="mt-1 text-xs text-gray-400">
              No built-in templates are available for this space.
            </p>
          )}
        </div>

        {/* Name */}
        <div>
          <label class="block text-sm font-medium text-gray-200 mb-1.5">
            Name
            <span class="text-red-400 ml-1">*</span>
          </label>
          <input
            type="text"
            value={name}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
              if (errors['name']) setErrors((prev) => ({ ...prev, name: '' }));
            }}
            placeholder="e.g., Senior Coder"
            class={`w-full bg-dark-800 border rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 ${
              errors['name'] ? 'border-red-700' : 'border-dark-600'
            }`}
            autoFocus
          />
          {errors['name'] && <p class="mt-1 text-xs text-red-400">{errors['name']}</p>}
        </div>

        {/* Description */}
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1.5">
            Description
            <span class="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            type="text"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
            placeholder="Briefly describe this agent's specialization..."
            class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Model */}
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1.5">
            Model
            <span class="text-gray-400 text-xs ml-2">(optional override)</span>
          </label>
          <WorkflowModelSelect
            value={model || undefined}
            provider={provider || undefined}
            onChange={(value, selection?: WorkflowModelSelection) => {
              setModel(value ?? '');
              setProvider(selection?.provider ?? '');
              if (errors['model']) setErrors((prev) => ({ ...prev, model: '' }));
            }}
            testId="space-agent-model-select"
            className={`w-full bg-dark-800 border rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500 font-mono text-sm ${
              errors['model'] ? 'border-red-700' : 'border-dark-600'
            }`}
          />
          {errors['model'] && <p class="mt-1 text-xs text-red-400">{errors['model']}</p>}
        </div>

        {/* Thinking Level */}
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1.5">
            Thinking Level
            <span class="text-gray-400 text-xs ml-2">(optional override)</span>
          </label>
          <select
            value={thinkingLevel}
            onChange={(e) =>
              setThinkingLevel((e.target as HTMLSelectElement).value as '' | ThinkingLevel)
            }
            class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500"
          >
            {THINKING_LEVEL_OPTIONS.map((option) => (
              <option key={option.value || 'default'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Setting Sources */}
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1.5">
            Setting Sources
            <span class="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          {isEdit && agent?.settingSources !== undefined && !clearSettingSources && (
            <button
              type="button"
              onClick={() => setClearSettingSources(true)}
              class="text-xs text-blue-400 hover:text-blue-300 mb-1.5"
            >
              Clear override — use inherited defaults
            </button>
          )}
          {clearSettingSources && (
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-xs text-gray-400">Will revert to inherited defaults on save.</span>
              <button
                type="button"
                onClick={() => setClearSettingSources(false)}
                class="text-xs text-blue-400 hover:text-blue-300"
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
                class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
              />
              <span class="text-sm text-gray-200">User settings</span>
              <span class="text-xs text-gray-400">(~/.claude/settings.json)</span>
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
                class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
              />
              <span class="text-sm text-gray-200">Project settings + CLAUDE.md</span>
              <span class="text-xs text-gray-400">(.claude/settings.json)</span>
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
                class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
              />
              <span class="text-sm text-gray-200">Local settings</span>
              <span class="text-xs text-gray-400">(.claude/settings.local.json)</span>
            </label>
          </div>
        </div>

        {/* Tools */}
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="block text-sm font-medium text-gray-200">
              Tools
              {toolsOverridden ? (
                <span class="text-red-400 ml-1">*</span>
              ) : (
                <span class="text-gray-400 text-xs ml-2">(inherited)</span>
              )}
            </label>
            {/* Tool presets */}
            <div class="flex gap-1.5">
              {isEdit && !toolsOverridden && (
                <button
                  type="button"
                  class="text-xs px-2.5 py-1 rounded border border-blue-600 bg-blue-900/20 text-blue-300"
                >
                  Inherited
                </button>
              )}
              {isEdit && toolsOverridden && (
                <button
                  type="button"
                  onClick={() => {
                    setToolsOverridden(false);
                    setActivePreset('Inherited');
                  }}
                  class="text-xs px-2.5 py-1 rounded border border-dark-600 text-gray-400 hover:border-dark-500 hover:text-gray-300"
                >
                  Inherit defaults
                </button>
              )}
              {[...Object.keys(TOOL_PRESETS), 'Custom'].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    if (preset !== 'Custom') applyPreset(preset);
                    else setActivePreset('Custom');
                  }}
                  class={`text-xs px-2.5 py-1 rounded border transition-colors ${
                    activePreset === preset
                      ? 'border-blue-600 bg-blue-900/20 text-blue-300'
                      : 'border-dark-600 text-gray-400 hover:border-dark-500 hover:text-gray-300'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
          <div class="grid grid-cols-3 gap-1.5">
            {(KNOWN_TOOLS as readonly string[]).map((tool) => {
              const checked = tools.includes(tool);
              return (
                <label
                  key={tool}
                  class={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-xs transition-colors ${
                    checked
                      ? 'border-blue-700/60 bg-blue-900/15 text-blue-200'
                      : 'border-dark-700 text-gray-400 hover:border-dark-600 hover:text-gray-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTool(tool)}
                    class="sr-only"
                  />
                  <span
                    class={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
                      checked ? 'bg-blue-600 border-blue-600' : 'border-dark-500'
                    }`}
                  >
                    {checked && (
                      <svg class="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
                        <path d="M10 3L5 8.5 2 5.5l-1 1L5 10.5l6-7-1-1z" />
                      </svg>
                    )}
                  </span>
                  {tool}
                </label>
              );
            })}
          </div>
          {errors['tools'] && <p class="mt-1.5 text-xs text-red-400">{errors['tools']}</p>}
        </div>

        {/* Custom Prompt */}
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">
            {isPromotion ? 'Long-Horizon Profile' : 'Custom Prompt'}
            <span class="text-gray-400 text-xs ml-2">
              (optional — appended after NeoKai contract)
            </span>
          </label>
          {isPromotion && (
            <p class="mb-2 text-xs text-gray-400">
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

        {/* Actions */}
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
