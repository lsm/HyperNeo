import { useState } from 'preact/hooks';
import { Popover, PopoverButton, PopoverPanel } from '../../src/mod.ts';

export function PopoverDemo() {
  const [notifications, setNotifications] = useState(true);
  const [autoSave, setAutoSave] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Basic popover with floating card
        </h3>
        <Popover class="relative inline-block">
          <PopoverButton class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer">
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
            </svg>
            Notifications
          </PopoverButton>
          <PopoverPanel class="absolute left-0 mt-2 w-72 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-4 z-10">
            <h4 class="text-sm font-semibold text-text-primary mb-2">Recent notifications</h4>
            <ul class="space-y-2">
              {[
                { icon: '✓', text: 'Build succeeded', time: '2 min ago', color: 'text-green-400' },
                {
                  icon: '⚠',
                  text: 'Test suite: 2 failures',
                  time: '5 min ago',
                  color: 'text-yellow-400',
                },
                {
                  icon: 'ℹ',
                  text: 'Deployment started',
                  time: '12 min ago',
                  color: 'text-accent-400',
                },
              ].map((n) => (
                <li class="flex items-start gap-3 text-sm" key={n.text}>
                  <span class={`${n.color} mt-0.5`}>{n.icon}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-text-primary truncate">{n.text}</p>
                    <p class="text-text-muted text-xs">{n.time}</p>
                  </div>
                </li>
              ))}
            </ul>
            <button class="mt-3 w-full text-xs text-center text-accent-400 hover:text-accent-300 transition-colors cursor-pointer">
              View all notifications
            </button>
          </PopoverPanel>
        </Popover>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Settings popover with form inputs (focus trapped)
        </h3>
        <Popover class="relative inline-block">
          <PopoverButton class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer">
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clip-rule="evenodd"
              />
            </svg>
            Settings
          </PopoverButton>
          <PopoverPanel
            focus
            class="absolute left-0 mt-2 w-80 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-4 z-10 outline-none"
          >
            <h4 class="text-sm font-semibold text-text-primary mb-4">Quick Settings</h4>
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <label class="text-sm text-text-secondary">Notifications</label>
                <button
                  role="switch"
                  aria-checked={notifications}
                  onClick={() => setNotifications((v) => !v)}
                  class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${notifications ? 'bg-accent-500' : 'bg-surface-3'}`}
                >
                  <span
                    class={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${notifications ? 'translate-x-5' : 'translate-x-1'}`}
                  />
                </button>
              </div>
              <div class="flex items-center justify-between">
                <label class="text-sm text-text-secondary">Auto-save</label>
                <button
                  role="switch"
                  aria-checked={autoSave}
                  onClick={() => setAutoSave((v) => !v)}
                  class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${autoSave ? 'bg-accent-500' : 'bg-surface-3'}`}
                >
                  <span
                    class={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${autoSave ? 'translate-x-5' : 'translate-x-1'}`}
                  />
                </button>
              </div>
              <div>
                <label class="block text-sm text-text-secondary mb-1.5">Theme</label>
                <div class="flex gap-2">
                  {(['dark', 'light'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      class={`flex-1 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer capitalize ${theme === t ? 'bg-accent-500 text-white' : 'bg-surface-2 text-text-secondary hover:bg-surface-3'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label class="block text-sm text-text-secondary mb-1.5">Display name</label>
                <input
                  type="text"
                  defaultValue="Jane Doe"
                  class="w-full bg-surface-2 border border-surface-border rounded px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-500 transition-colors"
                />
              </div>
            </div>
            <div class="mt-4 flex justify-end gap-2">
              <button class="px-3 py-1.5 rounded text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer">
                Cancel
              </button>
              <button class="px-3 py-1.5 rounded bg-accent-500 hover:bg-accent-600 text-white text-xs font-medium transition-colors cursor-pointer">
                Save
              </button>
            </div>
          </PopoverPanel>
        </Popover>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">Info popover (no focus trap)</h3>
        <Popover class="relative inline-block">
          <PopoverButton class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-surface-2 border border-surface-border text-text-tertiary hover:border-accent-500 hover:text-accent-400 transition-colors cursor-pointer text-xs font-bold">
            ?
          </PopoverButton>
          <PopoverPanel class="absolute left-8 top-0 w-56 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-3 z-10 text-xs text-text-secondary leading-relaxed">
            This is a simple info popover. It closes when you click outside or press Escape. Tab
            will also close it since focus is not trapped.
          </PopoverPanel>
        </Popover>
      </div>
    </div>
  );
}
