import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommandRegistry,
  commandRegistry,
  fuzzyScore,
  categoryLabel,
  formatShortcutDisplay,
  type CommandDescriptor,
} from '../command-registry.ts';

function cmd(id: string, overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return {
    id,
    label: overrides.label ?? id,
    category: overrides.category ?? 'help',
    run: overrides.run ?? (() => {}),
    ...overrides,
  };
}

describe('fuzzyScore', () => {
  it('returns 1 for empty query', () => {
    expect(fuzzyScore('anything', '')).toBe(1);
  });

  it('rewards exact match highest', () => {
    expect(fuzzyScore('open settings', 'open settings')).toBe(1000);
  });

  it('rewards prefix match', () => {
    const prefix = fuzzyScore('new session', 'new');
    const contains = fuzzyScore('open new', 'new');
    expect(prefix).toBeGreaterThan(contains);
  });

  it('returns 0 when characters are out of order', () => {
    expect(fuzzyScore('abc', 'cba')).toBe(0);
  });

  it('finds subsequence matches', () => {
    expect(fuzzyScore('go to sessions', 'gts')).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('Hello World', 'HELLO')).toBeGreaterThan(0);
  });

  it('returns positive score for substring match far into long text', () => {
    const haystack = 'a'.repeat(500) + 'needle' + 'b'.repeat(500);
    expect(fuzzyScore(haystack, 'needle')).toBeGreaterThan(0);
  });

  it('returns positive score for word-start match far into long text', () => {
    const haystack = 'a'.repeat(500) + ' needle' + 'b'.repeat(500);
    expect(fuzzyScore(haystack, 'needle')).toBeGreaterThan(0);
  });
});

describe('CommandRegistry', () => {
  let reg: CommandRegistry;
  beforeEach(() => {
    reg = new CommandRegistry();
  });

  it('registers and retrieves commands', () => {
    const c = cmd('a', { label: 'Alpha' });
    reg.register(c);
    expect(reg.get('a')).toBe(c);
    expect(reg.list()).toHaveLength(1);
  });

  it('overrides on duplicate id', () => {
    reg.register(cmd('a', { label: 'First' }));
    reg.register(cmd('a', { label: 'Second' }));
    expect(reg.get('a')?.label).toBe('Second');
    expect(reg.list()).toHaveLength(1);
  });

  it('unregisters and clears', () => {
    reg.registerAll([cmd('a'), cmd('b')]);
    reg.unregister('a');
    expect(reg.get('a')).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
    reg.clear();
    expect(reg.list()).toHaveLength(0);
  });

  it('returns every command for empty query', () => {
    reg.registerAll([cmd('a'), cmd('b'), cmd('c')]);
    expect(reg.search('').map((r) => r.command.id)).toEqual(['a', 'b', 'c']);
  });

  it('ranks matches by score descending', () => {
    reg.registerAll([
      cmd('a', { label: 'Open settings' }),
      cmd('b', { label: 'Settings: Providers' }),
      cmd('c', { label: 'Unrelated' }),
    ]);
    const results = reg.search('settings');
    expect(results[0]?.command.id).toBeDefined();
    expect(results.find((r) => r.command.id === 'c')).toBeUndefined();
  });

  it('matches against keywords and description', () => {
    reg.register(
      cmd('a', { label: 'New session', description: 'Create a chat', keywords: ['chat'] })
    );
    expect(reg.search('chat')[0]?.command.id).toBe('a');
    expect(reg.search('create')[0]?.command.id).toBe('a');
  });

  it('findByShortcut matches mod+key combos via metaKey (mac)', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const c = cmd('a', { shortcut: { code: 'KeyK', mod: true } });
    reg.register(c);
    const event = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      code: 'KeyK',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBe(c);
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('findByShortcut matches mod+key combos via ctrlKey (non-mac)', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    const c = cmd('a', { shortcut: { code: 'KeyK', mod: true } });
    reg.register(c);
    const event = {
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      code: 'KeyK',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBe(c);
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('findByShortcut rejects opposite modifier on mac', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    reg.register(cmd('a', { shortcut: { code: 'KeyK', mod: true } }));
    const event = {
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      code: 'KeyK',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBeUndefined();
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('findByShortcut rejects opposite modifier on non-mac', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    reg.register(cmd('a', { shortcut: { code: 'KeyK', mod: true } }));
    const event = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      code: 'KeyK',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBeUndefined();
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('findByShortcut rejects altKey for commands without alt', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    reg.register(cmd('a', { shortcut: { code: 'KeyK', mod: true } }));
    const event = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      code: 'KeyK',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBeUndefined();
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('findByShortcut returns the first matching command on shortcut collision', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const first = cmd('a', {
      label: 'First',
      shortcut: { code: 'Period', mod: true },
    });
    const second = cmd('b', {
      label: 'Second',
      shortcut: { code: 'Period', mod: true },
    });
    reg.register(first);
    reg.register(second);
    const event = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      code: 'Period',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBe(first);
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('findByShortcut ignores wrong modifier', () => {
    reg.register(cmd('a', { shortcut: { code: 'KeyK', mod: true } }));
    const event = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      code: 'KeyK',
    } as KeyboardEvent;
    expect(reg.findByShortcut(event)).toBeUndefined();
  });

  it('findByShortcut enforces shift requirement', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    reg.register(cmd('a', { shortcut: { code: 'KeyN', mod: true, shift: true } }));
    const without = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      code: 'KeyN',
    } as KeyboardEvent;
    const withShift = {
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      code: 'KeyN',
    } as KeyboardEvent;
    expect(reg.findByShortcut(without)).toBeUndefined();
    expect(reg.findByShortcut(withShift)?.id).toBe('a');
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });
});

describe('categoryLabel', () => {
  it('returns readable labels for each category', () => {
    expect(categoryLabel('session')).toBe('Sessions');
    expect(categoryLabel('navigation')).toBe('Navigation');
    expect(categoryLabel('settings')).toBe('Settings');
  });
});

describe('formatShortcutDisplay', () => {
  it('formats mac shortcuts with ⌘ glyph', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    expect(formatShortcutDisplay({ code: 'KeyK', mod: true })).toBe('⌘K');
    expect(formatShortcutDisplay({ code: 'KeyN', mod: true, shift: true })).toBe('⌘⇧N');
    expect(formatShortcutDisplay({ code: 'Comma', mod: true })).toBe('⌘,');
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });

  it('formats non-mac shortcuts with Ctrl/Shift labels', () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    expect(formatShortcutDisplay({ code: 'KeyK', mod: true })).toBe('Ctrl+K');
    expect(formatShortcutDisplay({ code: 'KeyN', mod: true, shift: true })).toBe('Ctrl+Shift+N');
    expect(formatShortcutDisplay({ code: 'Comma', mod: true })).toBe('Ctrl+,');
    Object.defineProperty(navigator, 'platform', { value: original, configurable: true });
  });
});

describe('singleton commandRegistry', () => {
  it('is shared across imports', () => {
    commandRegistry.clear();
    commandRegistry.register(cmd('shared'));
    expect(commandRegistry.get('shared')).toBeDefined();
    commandRegistry.clear();
  });
});
