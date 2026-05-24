import { SettingsSection } from './SettingsSection.tsx';
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
    <SettingsSection title="Keyboard Shortcuts">
      <p class="text-sm text-gray-400 mb-4">
        Press{' '}
        <kbd class="px-1.5 py-0.5 text-xs font-mono rounded bg-dark-700 border border-dark-600">
          ⌘K
        </kbd>{' '}
        (or{' '}
        <kbd class="px-1.5 py-0.5 text-xs font-mono rounded bg-dark-700 border border-dark-600">
          Ctrl+K
        </kbd>
        ) to open the command palette and run any command.
      </p>
      {groups.length === 0 ? (
        <p class="text-sm text-gray-500">No shortcuts registered.</p>
      ) : (
        <div class="space-y-6">
          {groups.map(([category, cmds]) => (
            <div key={category}>
              <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                {category}
              </h3>
              <ul class="divide-y divide-dark-700 rounded-lg border border-dark-700 overflow-hidden">
                {cmds.map((cmd) => (
                  <li
                    key={cmd.id}
                    class="flex items-center justify-between px-3 py-2 bg-dark-800/40"
                  >
                    <div class="min-w-0">
                      <div class="text-sm text-gray-200 truncate">{cmd.label}</div>
                      {cmd.description && (
                        <div class="text-xs text-gray-500 truncate">{cmd.description}</div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <kbd class="ml-3 flex-none px-1.5 py-0.5 text-xs font-mono rounded bg-dark-700 border border-dark-600 text-gray-300">
                        {formatShortcutDisplay(cmd.shortcut)}
                      </kbd>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
