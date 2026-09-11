import { describe, expect, it } from 'vitest';
import {
  differsFromBaseline,
  rebaseTemplateTools,
  trackAddedTools,
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
