import { cleanup, fireEvent, render } from '@testing-library/preact';
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

  it('saves the default chat view', () => {
    const { container } = render(<GeneralSettings />);
    const select = [...container.querySelectorAll('select')].find((element) =>
      [...element.options].some((option) => option.value === 'compact')
    )!;
    expect(select.value).toBe('compact');
    fireEvent.change(select, { target: { value: 'full' } });
    expect(updateGlobalSettings).toHaveBeenCalledWith({ chatDisplayMode: 'full' });
  });
});
