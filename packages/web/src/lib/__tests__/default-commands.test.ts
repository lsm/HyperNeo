import { describe, it, expect, beforeEach } from 'vitest';
import { commandRegistry } from '../command-registry.ts';
import {
  DEFAULT_COMMANDS,
  registerDefaultCommands,
  _resetDefaultCommandRegistration,
} from '../default-commands.ts';

describe('default commands', () => {
  beforeEach(() => {
    commandRegistry.clear();
    _resetDefaultCommandRegistration();
  });

  it('exposes a non-empty list', () => {
    expect(DEFAULT_COMMANDS.length).toBeGreaterThan(0);
  });

  it('every command has a unique id', () => {
    const ids = DEFAULT_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every shortcut has a code', () => {
    for (const cmd of DEFAULT_COMMANDS) {
      if (!cmd.shortcut) continue;
      expect(cmd.shortcut.code.length).toBeGreaterThan(0);
    }
  });

  it('includes a session.new command', () => {
    expect(DEFAULT_COMMANDS.find((c) => c.id === 'session.new')).toBeDefined();
  });

  it('includes a palette.open command bound to Cmd+K', () => {
    const palette = DEFAULT_COMMANDS.find((c) => c.id === 'palette.open');
    expect(palette).toBeDefined();
    expect(palette?.shortcut?.code).toBe('KeyK');
    expect(palette?.shortcut?.mod).toBe(true);
  });

  it('registers commands idempotently', () => {
    registerDefaultCommands();
    const first = commandRegistry.list().length;
    registerDefaultCommands();
    expect(commandRegistry.list().length).toBe(first);
    expect(first).toBe(DEFAULT_COMMANDS.length);
  });
});
