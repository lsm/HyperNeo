import type { SettingSource } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpaceHolder = vi.hoisted(() => ({
  current: null as { settingSources?: SettingSource[] } | null,
}));

const mockGlobalSettingsHolder = vi.hoisted(() => ({
  current: null as { settingSources?: SettingSource[] } | null,
}));

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      space: { value: mockSpaceHolder.current },
    };
  },
}));

vi.mock('../../../lib/state', () => ({
  get globalSettings() {
    return { value: mockGlobalSettingsHolder.current };
  },
}));

import { getInheritedSettingSources, SettingSourcesEditor } from '../SettingSourcesEditor';

function checkboxFor(label: string): HTMLInputElement {
  const labelText = screen.getByText(label);
  const wrapper = labelText.closest('label');
  if (!wrapper) throw new Error(`label not found for ${label}`);
  return within(wrapper).getByRole('checkbox') as HTMLInputElement;
}

beforeEach(() => {
  mockSpaceHolder.current = null;
  mockGlobalSettingsHolder.current = null;
});

afterEach(() => {
  cleanup();
});

describe('getInheritedSettingSources', () => {
  it('defaults to user/project/local when no space or global settings are loaded', () => {
    mockSpaceHolder.current = null;
    mockGlobalSettingsHolder.current = null;
    expect(getInheritedSettingSources()).toEqual(['user', 'project', 'local']);
  });

  it('defaults to user/project/local when neither space nor global settings define settingSources', () => {
    mockSpaceHolder.current = {};
    mockGlobalSettingsHolder.current = {};
    expect(getInheritedSettingSources()).toEqual(['user', 'project', 'local']);
  });

  it('returns the space settingSources when set', () => {
    mockSpaceHolder.current = { settingSources: ['project'] };
    mockGlobalSettingsHolder.current = { settingSources: ['user', 'local'] };
    expect(getInheritedSettingSources()).toEqual(['project']);
  });

  it('falls back to the global settingSources when the space has none', () => {
    mockSpaceHolder.current = {};
    mockGlobalSettingsHolder.current = { settingSources: ['user', 'local'] };
    expect(getInheritedSettingSources()).toEqual(['user', 'local']);
  });

  it('keeps an explicitly empty space settingSources instead of falling through', () => {
    mockSpaceHolder.current = { settingSources: [] };
    mockGlobalSettingsHolder.current = { settingSources: ['user', 'project', 'local'] };
    expect(getInheritedSettingSources()).toEqual([]);
  });
});

describe('SettingSourcesEditor', () => {
  it('renders the three setting sources with their setting file hints', () => {
    render(<SettingSourcesEditor value={['user', 'project', 'local']} onChange={vi.fn()} />);

    expect(screen.getByText('User settings')).toBeTruthy();
    expect(screen.getByText('(~/.claude/settings.json)')).toBeTruthy();
    expect(screen.getByText('Project settings + CLAUDE.md')).toBeTruthy();
    expect(screen.getByText('(.claude/settings.json)')).toBeTruthy();
    expect(screen.getByText('Local settings')).toBeTruthy();
    expect(screen.getByText('(.claude/settings.local.json)')).toBeTruthy();
  });

  it('checks exactly the sources present in the explicit value', () => {
    render(<SettingSourcesEditor value={['project', 'local']} onChange={vi.fn()} />);

    expect(checkboxFor('User settings').checked).toBe(false);
    expect(checkboxFor('Project settings + CLAUDE.md').checked).toBe(true);
    expect(checkboxFor('Local settings').checked).toBe(true);
  });

  it('falls back to the full default set when value is unset and no space is loaded', () => {
    render(<SettingSourcesEditor value={undefined} onChange={vi.fn()} />);

    expect(checkboxFor('User settings').checked).toBe(true);
    expect(checkboxFor('Project settings + CLAUDE.md').checked).toBe(true);
    expect(checkboxFor('Local settings').checked).toBe(true);
  });

  it('falls back to the space settingSources when value is null', () => {
    mockSpaceHolder.current = { settingSources: ['user'] };
    render(<SettingSourcesEditor value={null} onChange={vi.fn()} />);

    expect(checkboxFor('User settings').checked).toBe(true);
    expect(checkboxFor('Project settings + CLAUDE.md').checked).toBe(false);
    expect(checkboxFor('Local settings').checked).toBe(false);
  });

  it('falls back to the global settingSources when no space override exists', () => {
    mockSpaceHolder.current = {};
    mockGlobalSettingsHolder.current = { settingSources: ['user', 'local'] };
    render(<SettingSourcesEditor value={undefined} onChange={vi.fn()} />);

    expect(checkboxFor('User settings').checked).toBe(true);
    expect(checkboxFor('Project settings + CLAUDE.md').checked).toBe(false);
    expect(checkboxFor('Local settings').checked).toBe(true);
  });

  it('renders an explicitly empty value with every source unchecked', () => {
    mockSpaceHolder.current = { settingSources: ['user', 'project', 'local'] };
    render(<SettingSourcesEditor value={[]} onChange={vi.fn()} />);

    expect(checkboxFor('User settings').checked).toBe(false);
    expect(checkboxFor('Project settings + CLAUDE.md').checked).toBe(false);
    expect(checkboxFor('Local settings').checked).toBe(false);
  });

  it('removes a source from the explicit value on toggle off', () => {
    const onChange = vi.fn();
    render(<SettingSourcesEditor value={['user', 'project', 'local']} onChange={onChange} />);

    fireEvent.click(checkboxFor('Project settings + CLAUDE.md'));

    expect(onChange).toHaveBeenCalledWith(['user', 'local']);
  });

  it('appends a missing source on toggle on', () => {
    const onChange = vi.fn();
    render(<SettingSourcesEditor value={['user']} onChange={onChange} />);

    fireEvent.click(checkboxFor('Local settings'));

    expect(onChange).toHaveBeenCalledWith(['user', 'local']);
  });

  it('toggles from the inherited default when value is unset', () => {
    mockSpaceHolder.current = { settingSources: ['user', 'project'] };
    const onChange = vi.fn();
    render(<SettingSourcesEditor value={undefined} onChange={onChange} />);

    fireEvent.click(checkboxFor('Project settings + CLAUDE.md'));
    expect(onChange).toHaveBeenCalledWith(['user']);

    onChange.mockClear();
    fireEvent.click(checkboxFor('Local settings'));
    expect(onChange).toHaveBeenCalledWith(['user', 'project', 'local']);
  });

  it('disables every checkbox and swallows toggles when disabled', () => {
    const onChange = vi.fn();
    render(<SettingSourcesEditor value={['user']} onChange={onChange} disabled />);

    const checkboxes = [
      checkboxFor('User settings'),
      checkboxFor('Project settings + CLAUDE.md'),
      checkboxFor('Local settings'),
    ];
    for (const checkbox of checkboxes) {
      expect(checkbox.disabled).toBe(true);
      fireEvent.click(checkbox);
    }

    expect(onChange).not.toHaveBeenCalled();
  });
});
