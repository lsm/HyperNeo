import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { updateGlobalSettings } = vi.hoisted(() => ({
  updateGlobalSettings: vi.fn(async () => undefined),
}));

vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));

import { GeneralSettings } from '../GeneralSettings.tsx';

describe('GeneralSettings', () => {
  afterEach(() => {
    cleanup();
    updateGlobalSettings.mockClear();
  });

  it('keeps only GitHub polling; the rest moved to Preferences and Sessions & Harness', () => {
    const { queryByText } = render(<GeneralSettings />);
    for (const label of ['Language', 'Default chat view', 'Show Archived Sessions'])
      expect(queryByText(label)).toBeNull();
    expect(queryByText('Permission Mode')).toBeNull();
    expect(queryByText('Setting Sources')).toBeNull();
    expect(queryByText('GitHub polling interval (seconds)')).toBeTruthy();
  });

  it('has no default thinking control; it lives beside the default model', () => {
    const { container, queryByText } = render(<GeneralSettings />);
    expect(queryByText('Default Thinking Level')).toBeNull();
    const thinkingSelect = [...container.querySelectorAll('select')].find((element) =>
      [...element.options].some((option) => option.value === 'think16k')
    );
    expect(thinkingSelect).toBeUndefined();
  });
});
