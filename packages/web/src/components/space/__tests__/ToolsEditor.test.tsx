import { DENIABLE_TOOLS, KNOWN_TOOLS } from '@hyperneo/shared';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyToolsPreset,
  detectToolsPreset,
  ToolsEditor,
  type ToolsPresetName,
  type ToolsSelection,
  toggleKnownTool,
} from '../ToolsEditor';

const LEGACY_TOOL_PRESETS: Record<string, string[]> = {
  'Read Only': ['Read', 'Grep', 'Glob'],
};
const LEGACY_PRESET_BUTTONS = ['Inherit defaults', ...Object.keys(LEGACY_TOOL_PRESETS), 'Custom'];

interface LegacyToolsState {
  tools: string[];
  toolsOverridden: boolean;
  activePreset: string;
}

function legacyDetectPreset(toolList: string[] | null | undefined): string {
  if (toolList == null || toolList.length === 0) return 'Inherited';
  for (const [preset, presetTools] of Object.entries(LEGACY_TOOL_PRESETS)) {
    if (toolList.length === presetTools.length && presetTools.every((t) => toolList.includes(t))) {
      return preset;
    }
  }
  return 'Custom';
}

function legacyInheritTools(): LegacyToolsState {
  return { tools: [], toolsOverridden: false, activePreset: 'Inherited' };
}

function legacyStartCustom(): LegacyToolsState {
  return {
    tools: [...(KNOWN_TOOLS as readonly string[])],
    toolsOverridden: true,
    activePreset: 'Custom',
  };
}

function legacyApplyPreset(state: LegacyToolsState, presetName: string): LegacyToolsState {
  if (presetName in LEGACY_TOOL_PRESETS) {
    const presetTools = LEGACY_TOOL_PRESETS[presetName];
    if (presetTools.length === 0) {
      return { tools: [], toolsOverridden: false, activePreset: 'Inherited' };
    }
    return { tools: [...presetTools], toolsOverridden: true, activePreset: presetName };
  }
  return { ...state, activePreset: presetName };
}

function legacyPresetButtonDispatch(state: LegacyToolsState, preset: string): LegacyToolsState {
  if (preset === 'Inherit defaults') return legacyInheritTools();
  if (preset === 'Custom') return legacyStartCustom();
  return legacyApplyPreset(state, preset);
}

function legacyToggleTool(state: LegacyToolsState, tool: string): LegacyToolsState {
  const next = state.tools.includes(tool)
    ? state.tools.filter((t) => t !== tool)
    : [...state.tools, tool];
  if (next.length === 0) {
    return { tools: next, toolsOverridden: false, activePreset: 'Inherited' };
  }
  return { tools: next, toolsOverridden: true, activePreset: legacyDetectPreset(next) };
}

function legacyPresetButtonActive(state: LegacyToolsState, preset: string): boolean {
  return preset === 'Inherit defaults'
    ? !state.toolsOverridden
    : state.activePreset === preset && state.toolsOverridden;
}

function selectionAsLegacyState(selection: ToolsSelection): LegacyToolsState {
  return {
    tools: selection.tools,
    toolsOverridden: selection.toolsOverridden,
    activePreset: selection.toolsOverridden ? detectToolsPreset(selection.tools) : 'Inherited',
  };
}

const SAMPLE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'TaskList',
  'Skill',
  'Monitor',
];

const SAMPLE_SUBSETS: string[][] = SAMPLE_TOOLS.reduce<string[][]>(
  (subsets, tool) => subsets.concat(subsets.map((subset) => [...subset, tool])),
  [[]]
);

const READ_ONLY_PERMUTATIONS = [
  ['Read', 'Grep', 'Glob'],
  ['Read', 'Glob', 'Grep'],
  ['Grep', 'Read', 'Glob'],
  ['Glob', 'Grep', 'Read'],
];

describe('detectToolsPreset', () => {
  it('matches the SpaceAgentEditor detectPreset oracle across the tool-list corpus', () => {
    const corpus: Array<string[] | null | undefined> = [
      null,
      undefined,
      [],
      ...SAMPLE_SUBSETS,
      ...READ_ONLY_PERMUTATIONS,
      ['Read', 'Read', 'Grep'],
      ['Read', 'Grep', 'Glob', 'Bash'],
      [...(KNOWN_TOOLS as readonly string[])],
      ['Bash(npm run test:*)'],
    ];
    for (const toolList of corpus) {
      expect(detectToolsPreset(toolList)).toBe(legacyDetectPreset(toolList));
    }
  });

  it('classifies null and empty lists as Inherited', () => {
    expect(detectToolsPreset(null)).toBe('Inherited');
    expect(detectToolsPreset(undefined)).toBe('Inherited');
    expect(detectToolsPreset([])).toBe('Inherited');
  });

  it('detects the Read Only preset regardless of order and rejects near-misses', () => {
    for (const permutation of READ_ONLY_PERMUTATIONS) {
      expect(detectToolsPreset(permutation)).toBe('Read Only');
    }
    expect(detectToolsPreset(['Read', 'Grep'])).toBe('Custom');
    expect(detectToolsPreset(['Read', 'Grep', 'Bash'])).toBe('Custom');
    expect(detectToolsPreset(['Read', 'Grep', 'Glob', 'Bash'])).toBe('Custom');
  });
});

describe('applyToolsPreset', () => {
  it('matches the preset-button dispatch oracle for every button', () => {
    const startStates: LegacyToolsState[] = [
      legacyInheritTools(),
      legacyApplyPreset(legacyInheritTools(), 'Read Only'),
      legacyToggleTool(legacyStartCustom(), 'Bash'),
    ];
    for (const start of startStates) {
      for (const preset of LEGACY_PRESET_BUTTONS) {
        const next = applyToolsPreset(preset as ToolsPresetName);
        expect(selectionAsLegacyState(next)).toEqual(legacyPresetButtonDispatch(start, preset));
      }
    }
  });

  it('maps each button to its selection', () => {
    expect(applyToolsPreset('Inherit defaults')).toEqual({ tools: [], toolsOverridden: false });
    expect(applyToolsPreset('Read Only')).toEqual({
      tools: ['Read', 'Grep', 'Glob'],
      toolsOverridden: true,
    });
    expect(applyToolsPreset('Custom')).toEqual({
      tools: [...(KNOWN_TOOLS as readonly string[])],
      toolsOverridden: true,
    });
  });
});

describe('toggleKnownTool', () => {
  it('matches the toggleTool oracle for every reachable override state', () => {
    for (const subset of SAMPLE_SUBSETS) {
      if (subset.length === 0) continue;
      const start: LegacyToolsState = {
        tools: subset,
        toolsOverridden: true,
        activePreset: legacyDetectPreset(subset),
      };
      for (const tool of SAMPLE_TOOLS) {
        const next = toggleKnownTool(subset, tool);
        expect(selectionAsLegacyState(next)).toEqual(legacyToggleTool(start, tool));
      }
    }
  });

  it('removes a tool and stays overridden while tools remain', () => {
    expect(toggleKnownTool(['Read', 'Grep'], 'Grep')).toEqual({
      tools: ['Read'],
      toolsOverridden: true,
    });
  });

  it('appends a tool and marks the selection overridden', () => {
    expect(toggleKnownTool(['Read'], 'Grep')).toEqual({
      tools: ['Read', 'Grep'],
      toolsOverridden: true,
    });
  });

  it('falls back to inherited when the last tool is removed', () => {
    expect(toggleKnownTool(['Read'], 'Read')).toEqual({ tools: [], toolsOverridden: false });
  });
});

function Harness({ initial }: { initial: ToolsSelection }) {
  const [state, setState] = useState<ToolsSelection>(initial);
  return (
    <ToolsEditor tools={state.tools} toolsOverridden={state.toolsOverridden} onChange={setState} />
  );
}

const DENIABLE_TOOL_SET = new Set<string>(DENIABLE_TOOLS);

function presetTestId(preset: string): string {
  return `tools-editor-preset-${preset.toLowerCase().replace(/\s+/g, '-')}`;
}

function chipLabel(container: Element, tool: string): HTMLLabelElement {
  const label = container.querySelector(`[data-testid="tools-editor-chip-${tool}"]`);
  expect(label, `chip ${tool} rendered`).toBeTruthy();
  return label as HTMLLabelElement;
}

function chipInput(container: Element, tool: string): HTMLInputElement {
  const input = chipLabel(container, tool).querySelector('input');
  expect(input, `chip ${tool} input rendered`).toBeTruthy();
  return input as HTMLInputElement;
}

function presetButton(container: Element, preset: string): HTMLButtonElement {
  const button = container.querySelector(`[data-testid="${presetTestId(preset)}"]`);
  expect(button, `preset button ${preset} rendered`).toBeTruthy();
  return button as HTMLButtonElement;
}

function activePresetButtons(container: Element): string[] {
  const active: string[] = [];
  for (const preset of LEGACY_PRESET_BUTTONS) {
    if (presetButton(container, preset).className.includes('accent')) active.push(preset);
  }
  return active;
}

function expectDomMatchesLegacy(container: Element, legacy: LegacyToolsState): void {
  for (const tool of KNOWN_TOOLS) {
    const input = chipInput(container, tool);
    const inherited = !legacy.toolsOverridden;
    const checked = inherited || legacy.tools.includes(tool);
    const denied =
      legacy.toolsOverridden && legacy.tools.length > 0 && DENIABLE_TOOL_SET.has(tool) && !checked;
    expect(input.checked, `${tool} checked`).toBe(checked);
    expect(input.disabled, `${tool} disabled`).toBe(inherited);
    expect(
      chipLabel(container, tool).textContent?.includes('Denied'),
      `${tool} denied marker`
    ).toBe(denied);
  }
  const expectedActive = LEGACY_PRESET_BUTTONS.filter((preset) =>
    legacyPresetButtonActive(legacy, preset)
  );
  expect(activePresetButtons(container)).toEqual(expectedActive);
}

describe('ToolsEditor', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders inherited mode with all chips checked and disabled', () => {
    const { container, getByText } = render(<Harness initial={legacyInheritTools()} />);

    expectDomMatchesLegacy(container, legacyInheritTools());
    expect(getByText('(inherited)')).toBeTruthy();
    expect(
      getByText('This agent inherits all SDK built-in tools. No explicit overrides are set.')
    ).toBeTruthy();
  });

  it('reports the Read Only selection when its preset button is clicked', () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <ToolsEditor tools={[]} toolsOverridden={false} onChange={onChange} />
    );

    fireEvent.click(getByText('Read Only'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      tools: ['Read', 'Grep', 'Glob'],
      toolsOverridden: true,
    });
  });

  it('enters override mode from inherited when Custom is clicked', () => {
    const { container } = render(<Harness initial={legacyInheritTools()} />);

    fireEvent.click(presetButton(container, 'Custom'));

    expectDomMatchesLegacy(container, legacyStartCustom());
  });

  it('applies Read Only and checks only Read, Grep, Glob', () => {
    const { container } = render(<Harness initial={legacyInheritTools()} />);

    fireEvent.click(presetButton(container, 'Read Only'));

    expectDomMatchesLegacy(container, legacyApplyPreset(legacyInheritTools(), 'Read Only'));
  });

  it('marks unchecked deniable tools as denied and keeps others plain', () => {
    const { container } = render(<Harness initial={legacyInheritTools()} />);
    fireEvent.click(presetButton(container, 'Custom'));

    fireEvent.click(chipLabel(container, 'Bash'));
    fireEvent.click(chipLabel(container, 'WebFetch'));

    const afterBash = legacyToggleTool(legacyStartCustom(), 'Bash');
    expectDomMatchesLegacy(container, legacyToggleTool(afterBash, 'WebFetch'));
    expect(chipLabel(container, 'Bash').textContent).toContain('Denied');
    expect(chipLabel(container, 'WebFetch').textContent).not.toContain('Denied');
  });

  it('returns to inherited when the last checked tool is unchecked', () => {
    const { container, getByText } = render(<Harness initial={legacyInheritTools()} />);
    fireEvent.click(presetButton(container, 'Read Only'));

    for (const tool of ['Read', 'Grep', 'Glob']) {
      fireEvent.click(chipLabel(container, tool));
    }

    expectDomMatchesLegacy(container, legacyInheritTools());
    expect(getByText('(inherited)')).toBeTruthy();
  });

  it('switches the active preset indicator to Custom when a tool is toggled manually', () => {
    const { container } = render(<Harness initial={legacyInheritTools()} />);
    fireEvent.click(presetButton(container, 'Read Only'));

    fireEvent.click(chipLabel(container, 'Write'));

    expectDomMatchesLegacy(
      container,
      legacyToggleTool(legacyApplyPreset(legacyInheritTools(), 'Read Only'), 'Write')
    );
  });

  it('tracks the legacy editor state across an interaction sequence', () => {
    const { container } = render(<Harness initial={legacyInheritTools()} />);

    const sequence: Array<{ preset: string } | { tool: string }> = [
      { preset: 'Custom' },
      { tool: 'Bash' },
      { tool: 'Write' },
      { tool: 'TaskList' },
      { preset: 'Read Only' },
      { tool: 'Glob' },
      { tool: 'Grep' },
      { tool: 'Read' },
      { preset: 'Custom' },
      { tool: 'Read' },
    ];

    let legacy = legacyInheritTools();
    for (const step of sequence) {
      if ('preset' in step) {
        fireEvent.click(presetButton(container, step.preset));
        legacy = legacyPresetButtonDispatch(legacy, step.preset);
      } else {
        fireEvent.click(chipLabel(container, step.tool));
        legacy = legacyToggleTool(legacy, step.tool);
      }
      expectDomMatchesLegacy(container, legacy);
    }
  });
});
