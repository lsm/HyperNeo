export type CommandCategory = 'session' | 'navigation' | 'space' | 'settings' | 'tools' | 'help';

export interface CommandShortcut {
  code: string;
  mod?: boolean;
  shift?: boolean;
}

export interface CommandDescriptor {
  id: string;
  label: string;
  category: CommandCategory;
  description?: string;
  keywords?: readonly string[];
  shortcut?: CommandShortcut;
  run: () => void | Promise<void>;
}

export interface RankedCommand {
  command: CommandDescriptor;
  score: number;
}

const CATEGORY_LABEL: Record<CommandCategory, string> = {
  session: 'Sessions',
  navigation: 'Navigation',
  space: 'Spaces',
  settings: 'Settings',
  tools: 'Tools',
  help: 'Help',
};

export function categoryLabel(category: CommandCategory): string {
  return CATEGORY_LABEL[category];
}

function isMacPlatform(): boolean {
  return (
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? '') ||
    /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '')
  );
}

function codeToLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code === 'Period') return '.';
  if (code === 'Comma') return ',';
  if (code === 'Slash') return '/';
  return code;
}

export function formatShortcutDisplay(sc: CommandShortcut): string {
  const mod = isMacPlatform() ? '⌘' : 'Ctrl+';
  const shift = sc.shift ? (isMacPlatform() ? '⇧' : 'Shift+') : '';
  return `${mod}${shift}${codeToLabel(sc.code)}`;
}

export function fuzzyScore(haystack: string, query: string): number {
  if (!query) return 1;
  const hay = haystack.toLowerCase();
  const needle = query.toLowerCase();

  if (hay === needle) return 1000;
  if (hay.startsWith(needle)) return Math.max(1, 500 - (hay.length - needle.length));
  const wordStart = hay.indexOf(` ${needle}`);
  if (wordStart >= 0) return Math.max(1, 400 - wordStart);
  if (hay.includes(needle)) return Math.max(1, 300 - hay.indexOf(needle));

  let hi = 0;
  let lastIdx = -1;
  let gaps = 0;
  for (let qi = 0; qi < needle.length; qi++) {
    const ch = needle[qi];
    const next = hay.indexOf(ch, hi);
    if (next === -1) return 0;
    if (lastIdx !== -1) gaps += next - lastIdx - 1;
    lastIdx = next;
    hi = next + 1;
  }
  return Math.max(1, 200 - gaps - (hay.length - needle.length));
}

function commandSearchText(cmd: CommandDescriptor): string[] {
  const fields: string[] = [cmd.label];
  if (cmd.description) fields.push(cmd.description);
  if (cmd.keywords) fields.push(...cmd.keywords);
  fields.push(categoryLabel(cmd.category));
  return fields;
}

function scoreCommand(cmd: CommandDescriptor, query: string): number {
  if (!query) return 1;
  let best = 0;
  for (const field of commandSearchText(cmd)) {
    const s = fuzzyScore(field, query);
    if (s > best) best = s;
  }
  return best;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDescriptor>();

  register(cmd: CommandDescriptor): void {
    const sc = cmd.shortcut;
    if (sc) {
      for (const existing of this.commands.values()) {
        if (existing.id === cmd.id) continue;
        const e = existing.shortcut;
        if (!e) continue;
        if (e.code === sc.code && !!e.mod === !!sc.mod && !!e.shift === !!sc.shift) {
          // eslint-disable-next-line no-console
          console.warn(
            `[command-registry] shortcut collision: "${cmd.id}" shares ${formatShortcutDisplay(sc)} with "${existing.id}"; first registered wins.`
          );
          break;
        }
      }
    }
    this.commands.set(cmd.id, cmd);
  }

  registerAll(cmds: readonly CommandDescriptor[]): void {
    for (const c of cmds) this.register(c);
  }

  unregister(id: string): void {
    this.commands.delete(id);
  }

  clear(): void {
    this.commands.clear();
  }

  get(id: string): CommandDescriptor | undefined {
    return this.commands.get(id);
  }

  list(): CommandDescriptor[] {
    return Array.from(this.commands.values());
  }

  search(query: string): RankedCommand[] {
    const all = this.list();
    const trimmed = query.trim();
    if (!trimmed) {
      return all.map((command) => ({ command, score: 1 }));
    }
    const ranked: RankedCommand[] = [];
    for (const command of all) {
      const score = scoreCommand(command, trimmed);
      if (score > 0) ranked.push({ command, score });
    }
    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.command.label.localeCompare(b.command.label);
    });
    return ranked;
  }

  findByShortcut(event: KeyboardEvent): CommandDescriptor | undefined {
    const code = event.code;
    const isMac =
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? '') ||
      /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '');
    for (const cmd of this.commands.values()) {
      const sc = cmd.shortcut;
      if (!sc) continue;
      if (sc.code !== code) continue;
      if (sc.mod) {
        if (isMac) {
          if (!event.metaKey || event.ctrlKey) continue;
        } else {
          if (!event.ctrlKey || event.metaKey) continue;
        }
      } else {
        if (event.metaKey || event.ctrlKey) continue;
      }
      if (!!sc.shift !== event.shiftKey) continue;
      if (event.altKey) continue;
      return cmd;
    }
    return undefined;
  }
}

export const commandRegistry = new CommandRegistry();
