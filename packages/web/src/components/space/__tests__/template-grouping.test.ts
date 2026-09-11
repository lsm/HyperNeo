import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { groupTemplatesByLabel } from '../template-grouping';

function makeTemplate(key: string, labels?: string[]): SpaceLongHorizonAgentTemplate {
  return { key, labels } as unknown as SpaceLongHorizonAgentTemplate;
}

describe('groupTemplatesByLabel', () => {
  it('splits templates into the three labelled buckets in a fixed order', () => {
    const groups = groupTemplatesByLabel([
      makeTemplate('c'),
      makeTemplate('w', ['workflow-worker']),
      makeTemplate('l', ['long-horizon']),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['workflow-worker', 'long-horizon', 'custom']);
    expect(groups.map((group) => group.templates.map((template) => template.key))).toEqual([
      ['w'],
      ['l'],
      ['c'],
    ]);
  });

  it('drops empty groups', () => {
    const groups = groupTemplatesByLabel([makeTemplate('c')]);

    expect(groups.map((group) => group.key)).toEqual(['custom']);
  });

  it('treats a missing label list as custom', () => {
    const groups = groupTemplatesByLabel([makeTemplate('c', undefined)]);

    expect(groups[0]?.key).toBe('custom');
  });

  it('prefers workflow-worker when a template carries both labels', () => {
    const groups = groupTemplatesByLabel([
      makeTemplate('both', ['long-horizon', 'workflow-worker']),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['workflow-worker']);
  });

  it('keeps templates in input order within a group', () => {
    const groups = groupTemplatesByLabel([makeTemplate('c2'), makeTemplate('c1')]);

    expect(groups[0]?.templates.map((template) => template.key)).toEqual(['c2', 'c1']);
  });

  it('returns nothing for an empty library', () => {
    expect(groupTemplatesByLabel([])).toEqual([]);
  });
});
