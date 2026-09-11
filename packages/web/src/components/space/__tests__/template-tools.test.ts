import { describe, expect, it } from 'vitest';
import {
  decideToolsChange,
  differsFromBaseline,
  rebaseTemplateTools,
  trackAddedTools,
  type ToolsFormState,
  applyBaselineEdit,
  gateExplicitEdit,
  gateInheritPreset,
  gatePresetChoice,
  trackRemovedTools,
} from '../template-tools';

describe('rebaseTemplateTools', () => {
  it('adopts the new baseline when nothing was added or removed', () => {
    expect(rebaseTemplateTools(['Read'], ['Grep', 'Glob'], false, [], [])).toEqual([
      'Grep',
      'Glob',
    ]);
  });

  it('carries tracked additions onto the new baseline', () => {
    expect(rebaseTemplateTools(['Read'], ['Grep'], false, ['Bash(mine:*)'], [])).toEqual([
      'Grep',
      'Bash(mine:*)',
    ]);
  });

  it('does not duplicate an addition the new baseline contains', () => {
    expect(rebaseTemplateTools(['Read'], ['Grep'], false, ['Grep'], [])).toEqual(['Grep']);
  });

  it('honours a tracked removal', () => {
    expect(rebaseTemplateTools(['Read'], ['Bash', 'Grep'], false, [], ['Bash'])).toEqual(['Grep']);
  });

  it('keeps an addition across a baseline that happened to contain it', () => {
    expect(rebaseTemplateTools(['Bash(gh:*)'], ['Read'], false, ['Bash(gh:*)'], [])).toEqual([
      'Read',
      'Bash(gh:*)',
    ]);
  });

  it('leaves an explicit preset alone', () => {
    expect(rebaseTemplateTools(['Read', 'Grep'], ['Bash'], true, [], [])).toEqual(['Read', 'Grep']);
  });
});

describe('trackAddedTools', () => {
  it('records a tool the user added beyond the baseline', () => {
    expect(trackAddedTools([], ['Read'], ['Read', 'Bash(mine:*)'])).toEqual(['Bash(mine:*)']);
  });

  it('keeps an addition that a later baseline also contains', () => {
    expect(trackAddedTools(['Bash(gh:*)'], ['Bash(gh:*)'], ['Bash(gh:*)'])).toEqual(['Bash(gh:*)']);
  });

  it('forgets an addition once the user removes it', () => {
    expect(trackAddedTools(['Bash(mine:*)'], ['Read'], ['Read'])).toEqual([]);
  });
});

describe('trackRemovedTools', () => {
  it('records a baseline tool the user unchecked', () => {
    expect(trackRemovedTools([], ['Read', 'Bash'], ['Read'])).toEqual(['Bash']);
  });

  it('keeps an older removal that is still absent', () => {
    expect(trackRemovedTools(['Bash'], ['Grep'], ['Grep'])).toEqual(['Bash']);
  });

  it('forgets a removal once the tool is added back', () => {
    expect(trackRemovedTools(['Bash'], ['Bash'], ['Bash'])).toEqual([]);
  });

  it('does not duplicate a removal already tracked', () => {
    expect(trackRemovedTools(['Bash'], ['Read', 'Bash'], ['Read'])).toEqual(['Bash']);
  });
});

describe('differsFromBaseline', () => {
  it.each([
    [['Read'], ['Read'], false],
    [['Read'], ['Read', 'Grep'], true],
    [['Read', 'Extra'], ['Read'], true],
    [['Grep'], ['Read'], true],
  ])('compares %j against %j', (tools, baseline, expected) => {
    expect(differsFromBaseline(tools as string[], baseline as string[])).toBe(expected);
  });
});

const st = (over: Partial<ToolsFormState> = {}): ToolsFormState => ({
  tools: ['Read'],
  overridden: false,
  explicit: false,
  added: [],
  removed: [],
  ...over,
});

describe('gateInheritPreset', () => {
  it.each([
    ['an Inherit defaults preset', 'preset', false, 'reason'],
    ['a preset that sets an override', 'preset', true, 'value'],
    ['an ordinary edit that clears tools', 'edit', false, 'value'],
  ])('takes the %s arm for %s', (_label, origin, overridden, arm) => {
    const out = gateInheritPreset(origin as 'preset' | 'edit', overridden as boolean, ['Read']);
    expect(arm in out).toBe(true);
    if ('reason' in out) expect(out.reason).toEqual(st({ tools: ['Read'] }));
  });
});

describe('gatePresetChoice', () => {
  it('terminates as an explicit override for a preset', () => {
    const out = gatePresetChoice('preset', ['Read', 'Grep'], st({ removed: ['Bash'] }));
    expect('reason' in out).toBe(true);
    if ('reason' in out) {
      expect(out.reason.explicit).toBe(true);
      expect(out.reason.overridden).toBe(true);
      expect(out.reason.removed).toEqual(['Bash']);
    }
  });

  it('continues for an ordinary edit', () => {
    expect(gatePresetChoice('edit', ['Read'], st())).toEqual({ value: null });
  });
});

describe('gateExplicitEdit', () => {
  it('continues when no preset is active', () => {
    expect(gateExplicitEdit(['Read'], ['Read'], st({ explicit: false }))).toEqual({ value: null });
  });

  it('returns to inherited when the edit restores the baseline', () => {
    const out = gateExplicitEdit(['Read'], ['Read'], st({ explicit: true, removed: ['Bash'] }));
    expect('reason' in out).toBe(true);
    if ('reason' in out) expect(out.reason).toEqual(st({ tools: ['Read'] }));
  });

  it('stays overridden and tracks the addition otherwise', () => {
    const out = gateExplicitEdit(['Read', 'Bash(x:*)'], ['Bash'], st({ explicit: true }));
    expect('reason' in out).toBe(true);
    if ('reason' in out) {
      expect(out.reason.overridden).toBe(true);
      expect(out.reason.added).toContain('Bash(x:*)');
    }
  });

  it('keeps an emptied explicit selection overridden', () => {
    const out = gateExplicitEdit([], ['Bash'], st({ explicit: true }));
    if ('reason' in out) expect(out.reason.overridden).toBe(true);
  });
});

describe('applyBaselineEdit', () => {
  it('returns to inherited when nothing was added or removed', () => {
    expect(applyBaselineEdit(['Read'], ['Read'], st())).toEqual(st({ tools: ['Read'] }));
  });

  it('records a removal and stays overridden', () => {
    const out = applyBaselineEdit([], ['Bash'], st());
    expect(out.removed).toEqual(['Bash']);
    expect(out.overridden).toBe(true);
  });

  it('records an addition and stays overridden', () => {
    const out = applyBaselineEdit(['Read', 'Bash(x:*)'], ['Read'], st());
    expect(out.added).toEqual(['Bash(x:*)']);
    expect(out.overridden).toBe(true);
  });

  it('never reports explicit intent', () => {
    expect(applyBaselineEdit(['Read', 'Grep'], ['Read'], st()).explicit).toBe(false);
  });
});

describe('decideToolsChange precedence', () => {
  it('prefers the inherit-preset arm over later gates', () => {
    expect(decideToolsChange('preset', [], false, ['Read'], st({ explicit: true }))).toEqual(
      st({ tools: ['Read'] })
    );
  });

  it('prefers the preset arm over the explicit-edit gate', () => {
    const out = decideToolsChange('preset', ['Grep'], true, ['Read'], st({ explicit: true }));
    expect(out.tools).toEqual(['Grep']);
    expect(out.explicit).toBe(true);
  });

  it('falls through to the baseline edit when nothing terminates earlier', () => {
    const out = decideToolsChange('edit', [], true, ['Bash'], st());
    expect(out.removed).toEqual(['Bash']);
  });
});
