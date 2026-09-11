import { describe, expect, it } from 'vitest';
import { AUTONOMY_LABELS, toolPermissionsToolsList } from '../agent-page-labels';

describe('AUTONOMY_LABELS', () => {
  it('uses the one Space-wide label set, with level 5 as full autonomy', () => {
    expect(AUTONOMY_LABELS).toEqual({
      1: 'Supervised',
      2: 'Mostly supervised',
      3: 'Balanced',
      4: 'Mostly autonomous',
      5: 'Fully autonomous',
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
