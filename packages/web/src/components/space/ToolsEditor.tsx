import { DENIABLE_TOOLS, KNOWN_TOOLS } from '@hyperneo/shared';

type ToolName = (typeof KNOWN_TOOLS)[number];

const TOOL_PRESETS = {
  'Read Only': ['Read', 'Grep', 'Glob'],
} as const satisfies Record<string, readonly ToolName[]>;

type ToolPreset = keyof typeof TOOL_PRESETS;

export type ToolsPresetName = 'Inherit defaults' | ToolPreset | 'Custom';

const TOOL_PRESET_BUTTONS: readonly ToolsPresetName[] = [
  'Inherit defaults',
  ...(Object.keys(TOOL_PRESETS) as ToolPreset[]),
  'Custom',
];
const DENIABLE_TOOL_SET = new Set<string>(DENIABLE_TOOLS);

export interface ToolsSelection {
  tools: string[];
  toolsOverridden: boolean;
}

export function detectToolsPreset(toolList: string[] | null | undefined): string {
  if (toolList == null || toolList.length === 0) return 'Inherited';
  for (const [preset, presetTools] of Object.entries(TOOL_PRESETS)) {
    if (toolList.length === presetTools.length && presetTools.every((t) => toolList.includes(t))) {
      return preset;
    }
  }
  return 'Custom';
}

export function applyToolsPreset(preset: ToolsPresetName): ToolsSelection {
  if (preset === 'Inherit defaults') return { tools: [], toolsOverridden: false };
  if (preset === 'Custom') {
    return { tools: [...(KNOWN_TOOLS as readonly string[])], toolsOverridden: true };
  }
  const presetTools: readonly ToolName[] = TOOL_PRESETS[preset];
  if (presetTools.length === 0) return { tools: [], toolsOverridden: false };
  return { tools: [...presetTools], toolsOverridden: true };
}

export function toggleKnownTool(tools: string[], tool: string): ToolsSelection {
  const next = tools.includes(tool) ? tools.filter((t) => t !== tool) : [...tools, tool];
  return { tools: next, toolsOverridden: next.length > 0 };
}

export interface ToolsEditorProps {
  tools: string[];
  toolsOverridden: boolean;
  onChange: (next: ToolsSelection) => void;
}

export function ToolsEditor({ tools, toolsOverridden, onChange }: ToolsEditorProps) {
  const activePreset = toolsOverridden ? detectToolsPreset(tools) : 'Inherited';

  return (
    <div data-testid="tools-editor">
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
                data-testid={`tools-editor-preset-${preset.toLowerCase().replace(/\s+/g, '-')}`}
                onClick={() => onChange(applyToolsPreset(preset))}
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
              data-testid={`tools-editor-chip-${tool}`}
              class={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs transition-colors ${
                inherited
                  ? 'border-line-strong bg-surface-raised/40 text-fg-faint cursor-not-allowed'
                  : checked
                    ? 'border-accent/60 bg-accent/15 text-accent-soft cursor-pointer'
                    : denied
                      ? 'border-danger/60 bg-danger/15 text-danger-soft hover:border-danger cursor-pointer'
                      : 'border-line text-fg-muted hover:border-line-strong hover:text-fg-soft cursor-pointer'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={inherited}
                onChange={() => {
                  if (!inherited) onChange(toggleKnownTool(tools, tool));
                }}
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
                  <svg class="w-2.5 h-2.5 text-accent-fg" fill="currentColor" viewBox="0 0 12 12">
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
    </div>
  );
}
