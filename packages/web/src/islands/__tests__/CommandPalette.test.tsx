// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/preact';
import { CommandPalette } from '../CommandPalette.tsx';
import { commandRegistry } from '../../lib/command-registry.ts';
import { commandPaletteModeSignal, commandPaletteOpenSignal } from '../../lib/signals.ts';

describe('CommandPalette', () => {
  beforeEach(() => {
    commandRegistry.clear();
    commandPaletteOpenSignal.value = false;
    commandPaletteModeSignal.value = 'commands';
  });

  afterEach(() => {
    cleanup();
    commandRegistry.clear();
    commandPaletteOpenSignal.value = false;
    commandPaletteModeSignal.value = 'commands';
    vi.restoreAllMocks();
  });

  it('renders nothing visible when closed', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-input')).toBeNull();
  });

  it('renders input and seeded commands when opened', async () => {
    commandRegistry.register({
      id: 'a',
      label: 'Alpha command',
      category: 'help',
      run: () => {},
    });
    commandPaletteOpenSignal.value = true;
    render(<CommandPalette />);
    expect(await screen.findByTestId('command-palette-input')).toBeTruthy();
    expect(screen.getByText('Alpha command')).toBeTruthy();
  });

  it('filters commands via fuzzy search', async () => {
    commandRegistry.register({
      id: 'a',
      label: 'Alpha command',
      category: 'help',
      run: () => {},
    });
    commandRegistry.register({
      id: 'b',
      label: 'Beta command',
      category: 'help',
      run: () => {},
    });
    commandPaletteOpenSignal.value = true;
    render(<CommandPalette />);
    const input = await screen.findByTestId('command-palette-input');
    fireEvent.input(input, { target: { value: 'alp' } });
    expect(screen.getByText('Alpha command')).toBeTruthy();
    expect(screen.queryByText('Beta command')).toBeNull();
  });

  it('shows empty state when nothing matches', async () => {
    commandRegistry.register({
      id: 'a',
      label: 'Alpha command',
      category: 'help',
      run: () => {},
    });
    commandPaletteOpenSignal.value = true;
    render(<CommandPalette />);
    const input = await screen.findByTestId('command-palette-input');
    fireEvent.input(input, { target: { value: 'zzzzzz' } });
    expect(screen.getByTestId('command-palette-empty')).toBeTruthy();
  });

  it('closes when the open signal flips to false', async () => {
    commandPaletteOpenSignal.value = true;
    render(<CommandPalette />);
    expect(await screen.findByTestId('command-palette-input')).toBeTruthy();
    commandPaletteOpenSignal.value = false;
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('command-palette-input')).toBeNull();
  });

  it('swallows async rejections from a command run handler', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    commandRegistry.register({
      id: 'fail',
      label: 'Failing command',
      category: 'help',
      run,
    });
    commandPaletteOpenSignal.value = true;
    render(<CommandPalette />);
    await screen.findByText('Failing command');
    fireEvent.click(screen.getByText('Failing command'));
    await new Promise((r) => setTimeout(r, 10));
    expect(run).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});
