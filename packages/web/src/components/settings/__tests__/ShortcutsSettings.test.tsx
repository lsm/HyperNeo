// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { ShortcutsSettings } from '../ShortcutsSettings.tsx';
import { commandRegistry } from '../../../lib/command-registry.ts';

describe('ShortcutsSettings', () => {
  beforeEach(() => {
    commandRegistry.clear();
  });

  afterEach(() => {
    cleanup();
    commandRegistry.clear();
  });

  it('renders empty state when no shortcuts are registered', () => {
    render(<ShortcutsSettings />);
    expect(screen.getByText('No shortcuts registered.')).toBeTruthy();
  });

  it('lists registered shortcuts grouped by category', () => {
    commandRegistry.register({
      id: 'a',
      label: 'Open palette',
      category: 'help',
      shortcut: { code: 'KeyK', mod: true },
      run: () => {},
    });
    commandRegistry.register({
      id: 'b',
      label: 'New session',
      category: 'session',
      shortcut: { code: 'KeyN', mod: true, shift: true },
      run: () => {},
    });
    commandRegistry.register({
      id: 'c',
      label: 'No shortcut command',
      category: 'help',
      run: () => {},
    });

    render(<ShortcutsSettings />);
    expect(screen.getByText('Open palette')).toBeTruthy();
    expect(screen.getByText('New session')).toBeTruthy();
    expect(screen.queryByText('No shortcut command')).toBeNull();
    expect(screen.getByText('Help')).toBeTruthy();
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getAllByText(/K/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/N/).length).toBeGreaterThan(0);
  });
});
