import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { updateGlobalSettings } = vi.hoisted(() => ({
  updateGlobalSettings: vi.fn(async () => undefined),
}));

vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));

import { GeneralSettings } from '../GeneralSettings.tsx';
import { globalStore } from '../../../lib/global-store.ts';

function permissionSelect(container: Element) {
  return [...container.querySelectorAll('select')].find((element) =>
    [...element.options].some((option) => option.value === 'acceptEdits')
  )!;
}

function shown(select: HTMLSelectElement) {
  return select.options[select.selectedIndex].textContent;
}

describe('GeneralSettings SDK permission mode', () => {
  afterEach(() => {
    cleanup();
    globalStore.settings.value = null;
    updateGlobalSettings.mockClear();
  });

  it.each([
    ['unset', undefined, 'default', 'bypassPermissions (Default)'],
    ['default', 'default', 'default', 'bypassPermissions (Default)'],
    ['bypassPermissions', 'bypassPermissions', 'bypassPermissions', 'bypassPermissions'],
    ['acceptEdits', 'acceptEdits', 'acceptEdits', 'acceptEdits'],
    ['plan', 'plan', 'plan', 'plan'],
    ['legacy delegate', 'delegate', 'delegate', 'delegate (legacy, compatibility unconfirmed)'],
    ['other legacy value', 'dontAsk', 'dontAsk', 'dontAsk (legacy, compatibility unconfirmed)'],
  ])(
    'shows a saved %s value by its real name and writes nothing on open',
    (_name, saved, value, label) => {
      globalStore.settings.value = { permissionMode: saved } as unknown as GlobalSettings;
      const { container } = render(<GeneralSettings />);
      const select = permissionSelect(container);
      expect(select.value).toBe(value);
      expect(shown(select)).toBe(label);
      expect(updateGlobalSettings).not.toHaveBeenCalled();
    }
  );

  it('offers only names the SDK path passes through, not delegate', () => {
    globalStore.settings.value = {} as GlobalSettings;
    const { container } = render(<GeneralSettings />);
    expect([...permissionSelect(container).options].map((option) => option.textContent)).toEqual([
      'bypassPermissions (Default)',
      'acceptEdits',
      'plan',
    ]);
  });

  it('says Default runs as bypassPermissions and applies to HyperNeo SDK sessions', () => {
    const { container } = render(<GeneralSettings />);
    expect(container.textContent).toContain(
      'Default or unset runs new HyperNeo SDK sessions with bypassPermissions.'
    );
  });

  it('an unrelated save leaves a legacy permission value untouched', () => {
    globalStore.settings.value = { permissionMode: 'delegate' } as unknown as GlobalSettings;
    const { container } = render(<GeneralSettings />);
    const language = [...container.querySelectorAll('select')].find((element) =>
      [...element.options].some((option) => option.value === 'zh-Hans')
    )!;
    fireEvent.change(language, { target: { value: 'zh-Hans' } });
    expect(updateGlobalSettings).toHaveBeenCalledTimes(1);
    expect(updateGlobalSettings).toHaveBeenCalledWith({ language: 'zh-Hans' });
    expect(permissionSelect(container).value).toBe('delegate');
  });

  it('saves the real name the person picks', () => {
    const { container } = render(<GeneralSettings />);
    fireEvent.change(permissionSelect(container), { target: { value: 'plan' } });
    expect(updateGlobalSettings).toHaveBeenCalledWith({ permissionMode: 'plan' });
  });
});
