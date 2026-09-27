import { SettingsGroup, SettingsSection } from './SettingsSection.tsx';
import {
  commandRegistry,
  categoryLabel,
  formatShortcutDisplay,
  type CommandDescriptor,
} from '../../lib/command-registry.ts';

function groupedCommands(): Array<[string, CommandDescriptor[]]> {
  const groups = new Map<string, CommandDescriptor[]>();
  for (const cmd of commandRegistry.list()) {
    if (!cmd.shortcut) continue;
    const key = categoryLabel(cmd.category);
    const list = groups.get(key) ?? [];
    list.push(cmd);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
}

export function ShortcutsSettings() {
  const groups = groupedCommands();
  return (
    <SettingsSection
      title="Keyboard Shortcuts"
      description="Press ⌘K (or Ctrl+K) to open the command palette and run any command."
    >
      {groups.length === 0 ? (
        <p class="text-sm text-fg-faint">No shortcuts registered.</p>
      ) : (
        <div class="space-y-6">
          {groups.map(([category, cmds]) => (
            <div key={category}>
              <h3 class="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2 px-1">
                {category}
              </h3>
              <SettingsGroup>
                {cmds.map((cmd) => (
                  <li key={cmd.id} class="flex items-center justify-between px-4 py-2.5">
                    <div class="min-w-0">
                      <div class="text-sm text-fg-soft truncate">{cmd.label}</div>
                      {cmd.description && (
                        <div class="text-xs text-fg-faint truncate">{cmd.description}</div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <kbd class="ml-3 flex-none px-1.5 py-0.5 text-xs font-mono rounded bg-fill-strong border border-line-strong text-fg-soft">
                        {formatShortcutDisplay(cmd.shortcut)}
                      </kbd>
                    )}
                  </li>
                ))}
              </SettingsGroup>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
