import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/preact';
import { useGlobalShortcuts } from '../useGlobalShortcuts.ts';
import { commandRegistry } from '../../lib/command-registry.ts';
import { commandPaletteModeSignal, commandPaletteOpenSignal } from '../../lib/signals.ts';

function fireKey(opts: KeyboardEventInit & { target?: HTMLElement }) {
  const { target, ...init } = opts;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(event);
  return event;
}

function setPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', {
    value,
    configurable: true,
  });
}

describe('useGlobalShortcuts', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
    commandRegistry.clear();
    commandPaletteOpenSignal.value = false;
    commandPaletteModeSignal.value = 'commands';
  });

  afterEach(() => {
    commandRegistry.clear();
    commandPaletteOpenSignal.value = false;
    commandPaletteModeSignal.value = 'commands';
    if (originalPlatform) {
      Object.defineProperty(navigator, 'platform', originalPlatform);
    }
    vi.restoreAllMocks();
  });

  it('toggles command palette on Cmd+K on mac', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK', metaKey: true });
    expect(commandPaletteOpenSignal.value).toBe(true);
    expect(commandPaletteModeSignal.value).toBe('commands');
    fireKey({ code: 'KeyK', metaKey: true });
    expect(commandPaletteOpenSignal.value).toBe(false);
  });

  it('opens quick open on Cmd+P on mac', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyP', metaKey: true });
    expect(commandPaletteOpenSignal.value).toBe(true);
    expect(commandPaletteModeSignal.value).toBe('quick-open');
  });

  it('does not toggle on Ctrl+K on mac (native editing shortcut)', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK', ctrlKey: true });
    expect(commandPaletteOpenSignal.value).toBe(false);
  });

  it('toggles on Ctrl+K on non-mac', () => {
    setPlatform('Win32');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK', ctrlKey: true });
    expect(commandPaletteOpenSignal.value).toBe(true);
    expect(commandPaletteModeSignal.value).toBe('commands');
  });

  it('does not toggle on Cmd+K on non-mac', () => {
    setPlatform('Win32');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK', metaKey: true });
    expect(commandPaletteOpenSignal.value).toBe(false);
  });

  it('does not toggle on plain k', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK' });
    expect(commandPaletteOpenSignal.value).toBe(false);
  });

  it('does not toggle when altKey is held', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK', metaKey: true, altKey: true });
    expect(commandPaletteOpenSignal.value).toBe(false);
  });

  it('runs registered command shortcut', () => {
    setPlatform('MacIntel');
    let ran = 0;
    commandRegistry.register({
      id: 'test',
      label: 'Test',
      category: 'help',
      shortcut: { code: 'Period', mod: true },
      run: () => {
        ran += 1;
      },
    });
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'Period', metaKey: true });
    expect(ran).toBe(1);
  });

  it('ignores auto-repeat keydown for shortcuts', () => {
    setPlatform('MacIntel');
    let ran = 0;
    commandRegistry.register({
      id: 'test',
      label: 'Test',
      category: 'help',
      shortcut: { code: 'Period', mod: true },
      run: () => {
        ran += 1;
      },
    });
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'Period', metaKey: true });
    fireKey({ code: 'Period', metaKey: true, repeat: true });
    fireKey({ code: 'Period', metaKey: true, repeat: true });
    expect(ran).toBe(1);
  });

  it('ignores auto-repeat keydown for palette toggle', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'KeyK', metaKey: true });
    expect(commandPaletteOpenSignal.value).toBe(true);
    fireKey({ code: 'KeyK', metaKey: true, repeat: true });
    expect(commandPaletteOpenSignal.value).toBe(true);
  });

  it('ignores command shortcuts while typing in a text input', () => {
    setPlatform('MacIntel');
    let ran = 0;
    commandRegistry.register({
      id: 'test',
      label: 'Test',
      category: 'help',
      shortcut: { code: 'Period', mod: true },
      run: () => {
        ran += 1;
      },
    });
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    fireKey({ code: 'Period', metaKey: true, target: input });
    input.remove();
    expect(ran).toBe(0);
  });

  it('ignores command shortcuts when altKey is held', () => {
    setPlatform('MacIntel');
    let ran = 0;
    commandRegistry.register({
      id: 'test',
      label: 'Test',
      category: 'help',
      shortcut: { code: 'Period', mod: true },
      run: () => {
        ran += 1;
      },
    });
    renderHook(() => useGlobalShortcuts());
    fireKey({ code: 'Period', metaKey: true, altKey: true });
    expect(ran).toBe(0);
  });

  it('still toggles palette while typing (mac, Cmd+K)', () => {
    setPlatform('MacIntel');
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    fireKey({ code: 'KeyK', metaKey: true, target: input });
    input.remove();
    expect(commandPaletteOpenSignal.value).toBe(true);
  });
});
