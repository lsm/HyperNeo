import { describe, expect, it } from 'vitest';
import { AUTONOMY_LABELS, toolPermissionsToolsList } from '../agent-page-labels';

describe('AUTONOMY_LABELS', () => {
  it('labels every autonomy level the agents page can render', () => {
    expect(AUTONOMY_LABELS).toEqual({
      1: 'Supervised',
      2: 'Semi-auto',
      3: 'Autonomous',
      4: 'Full auto',
      5: 'Unrestricted',
    });
  });
});

describe('toolPermissionsToolsList', () => {
  it('returns the declared tools', () => {
    expect(toolPermissionsToolsList({ toolPermissions: { tools: ['Read', 'Grep'] } })).toEqual([
      'Read',
      'Grep',
    ]);
  });

  it('drops entries that are not strings', () => {
    expect(
      toolPermissionsToolsList({ toolPermissions: { tools: ['Read', 7, null, 'Grep'] } })
    ).toEqual(['Read', 'Grep']);
  });

  it('is empty when tools is missing or not an array', () => {
    expect(toolPermissionsToolsList({ toolPermissions: {} })).toEqual([]);
    expect(toolPermissionsToolsList({ toolPermissions: { tools: 'Read' } })).toEqual([]);
  });
});
