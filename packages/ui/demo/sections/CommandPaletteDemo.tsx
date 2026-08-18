import { useState } from 'preact/hooks';
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Dialog,
  DialogBackdrop,
  DialogPanel,
} from '../../src/mod.ts';

interface CommandItem {
  id: string;
  name: string;
  type: 'project' | 'action' | 'recent';
  shortcut?: string;
  description?: string;
}

const recentItems: CommandItem[] = [
  { id: 'recent-1', name: 'Workflow Inc. / Website Redesign', type: 'recent' },
  { id: 'recent-2', name: 'Mobile App / iOS Development', type: 'recent' },
];

const actions: CommandItem[] = [
  {
    id: 'action-1',
    name: 'Create new project...',
    type: 'action',
    shortcut: 'N',
    description: 'Start a fresh project',
  },
  {
    id: 'action-2',
    name: 'Create new file...',
    type: 'action',
    shortcut: 'F',
    description: 'Add a new file to the workspace',
  },
  {
    id: 'action-3',
    name: 'Add collaborator...',
    type: 'action',
    shortcut: 'C',
    description: 'Invite a team member',
  },
  {
    id: 'action-4',
    name: 'Open settings',
    type: 'action',
    shortcut: ',',
    description: 'Configure preferences',
  },
];

const projects: CommandItem[] = [
  { id: 'project-1', name: 'Workflow Inc. / Website Redesign', type: 'project' },
  { id: 'project-2', name: 'Mobile App / iOS Development', type: 'project' },
  { id: 'project-3', name: 'Marketing / Q4 Campaign', type: 'project' },
  { id: 'project-4', name: 'Infrastructure / Cloud Migration', type: 'project' },
];

function SearchIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3.75 3A2.25 2.25 0 001.5 5.25v9.5A2.25 2.25 0 003.75 17h12.5A2.25 2.25 0 0018.5 14.75v-6.5a2.25 2.25 0 00-2.25-2.25H9.227l-1.721-2.153A1.5 1.5 0 006.292 3H3.75z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M13.3 2.3a.75.75 0 00-1.06-1.06L8.47 4.98a.75.75 0 000 1.06l3.77 3.77a.75.75 0 001.06-1.06l-3.04-3.04 2.76-2.34z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function CommandIcon() {
  return (
    <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3.5 3A1.5 1.5 0 002 4.5v1A1.5 1.5 0 003.5 7h1A1.5 1.5 0 006 8.5v1A1.5 1.5 0 004.5 11h-1A1.5 1.5 0 002 9.5v-1A1.5 1.5 0 003.5 7H4.5v1h-.5a.5.5 0 000 1h.5v1.5a.5.5 0 001 0V8.5h.5a.5.5 0 000-1H5V6h.5a.5.5 0 000-1H5v-.5A.5.5 0 004.5 4H4a.5.5 0 000-1h-.5z" />
      <path d="M9.5 3a.5.5 0 01.5.5V4h1a.5.5 0 010 1h-.5v.5a.5.5 0 01-1 0V5H8.5a.5.5 0 010-1h.5v-.5A.5.5 0 019.5 3z" />
      <path d="M14.5 3a.5.5 0 00-.5.5V4h-1a.5.5 0 000 1h.5v.5a.5.5 0 101 0V5h.5a.5.5 0 000-1H14v-.5A.5.5 0 0014.5 3z" />
      <path
        fill-rule="evenodd"
        d="M16 9.5a.5.5 0 00-.5-.5h-1a.5.5 0 000 1h.5v.5a.5.5 0 001 0v-.5h.5a.5.5 0 000-1h-.5V9.5z"
        clip-rule="evenodd"
      />
      <path
        fill-rule="evenodd"
        d="M3 10a.5.5 0 01.5-.5h1a.5.5 0 010 1H4v.5a.5.5 0 01-1 0V10.5H2.5a.5.5 0 010-1h1v-.5A.5.5 0 013 9.5z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function CommandPaletteDemo() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filteredProjects =
    query === '' ? [] : projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  const filteredActions =
    query === ''
      ? actions
      : actions.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()));

  const showResults = query !== '' || filteredActions.length > 0;

  function handleClose() {
    setOpen(false);
    setQuery('');
  }

  function handleSelect(_item: CommandItem) {
    handleClose();
  }

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Command Palette — Dialog + Combobox composition
        </h3>
        <button
          type="button"
          onClick={() => setOpen(true)}
          class="inline-flex items-center gap-2 bg-surface-2 hover:bg-surface-3 border border-surface-border text-text-primary px-4 py-2 rounded-lg text-sm transition-colors cursor-pointer"
        >
          <SearchIcon />
          <span>Search or jump to...</span>
          <kbd class="ml-4 px-1.5 py-0.5 text-xs bg-surface-3 border border-surface-border rounded font-mono text-text-tertiary">
            ⌘K
          </kbd>
        </button>
      </div>

      <p class="text-xs text-text-muted">
        Combines <code class="text-accent-400 font-mono">Dialog</code> as the modal container with{' '}
        <code class="text-accent-400 font-mono">Combobox</code> for searchable options. Shows recent
        items, grouped results, keyboard shortcuts, and a footer with tips.
      </p>

      <Dialog open={open} onClose={handleClose} class="relative z-50">
        <DialogBackdrop class="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity data-[closed]:opacity-0 data-[enter]:duration-300 data-[enter]:ease-out data-[leave]:duration-200 data-[leave]:ease-in" />

        <div class="fixed inset-0 z-10 overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel class="mx-auto max-w-2xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-1 shadow-2xl border border-surface-border outline-1 outline-surface-border transition-all data-[closed]:scale-95 data-[closed]:opacity-0 data-[enter]:duration-300 data-[enter]:ease-out data-[leave]:duration-200 data-[leave]:ease-in">
            <Combobox onChange={handleSelect}>
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-14 w-full pr-4 pl-12 text-base text-text-primary bg-transparent outline-none placeholder:text-text-muted"
                  placeholder="Search projects, actions, or type a command..."
                  displayValue={() => query}
                  onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
                />
                <span class="col-start-1 row-start-1 ml-4 self-center text-text-tertiary pointer-events-none">
                  <SearchIcon />
                </span>
              </div>

              {showResults && (
                <ComboboxOptions static class="max-h-80 scroll-py-2 overflow-y-auto">
                  {query === '' && recentItems.length > 0 && (
                    <li class="p-2">
                      <h2 class="px-3 py-2 text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                        Recent
                      </h2>
                      <ul class="text-sm text-text-secondary">
                        {recentItems.map((item) => (
                          <ComboboxOption
                            key={item.id}
                            value={item}
                            class="group flex cursor-default items-center rounded-lg px-3 py-2.5 select-none data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
                          >
                            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3 group-data-[focus]:bg-accent-600 text-text-tertiary group-data-[focus]:text-white transition-colors">
                              <FolderIcon />
                            </span>
                            <span class="ml-3 flex-auto truncate">{item.name}</span>
                            <span class="ml-3 hidden flex-none text-xs text-text-muted group-data-[focus]:text-accent-200">
                              Jump to
                            </span>
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  )}

                  <li class="p-2">
                    <h2 class="px-3 py-2 text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                      {query === '' ? 'Quick actions' : 'Actions'}
                    </h2>
                    <ul class="text-sm text-text-secondary">
                      {filteredActions.map((item) => (
                        <ComboboxOption
                          key={item.id}
                          value={item}
                          class="group flex cursor-default items-center rounded-lg px-3 py-2.5 select-none data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
                        >
                          <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3 group-data-[focus]:bg-accent-600 text-text-tertiary group-data-[focus]:text-white transition-colors">
                            <BoltIcon />
                          </span>
                          <span class="ml-3 flex-auto truncate">{item.name}</span>
                          {item.shortcut && (
                            <span class="ml-3 flex-none">
                              <kbd class="px-1.5 py-0.5 text-xs font-mono rounded bg-surface-3 group-data-[focus]:bg-accent-600 text-text-muted group-data-[focus]:text-accent-200 border border-surface-border group-data-[focus]:border-accent-400">
                                ⌘{item.shortcut}
                              </kbd>
                            </span>
                          )}
                        </ComboboxOption>
                      ))}
                    </ul>
                  </li>

                  {query !== '' && filteredProjects.length > 0 && (
                    <li class="p-2">
                      <h2 class="px-3 py-2 text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                        Projects
                      </h2>
                      <ul class="text-sm text-text-secondary">
                        {filteredProjects.map((item) => (
                          <ComboboxOption
                            key={item.id}
                            value={item}
                            class="group flex cursor-default items-center rounded-lg px-3 py-2.5 select-none data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
                          >
                            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3 group-data-[focus]:bg-accent-600 text-text-tertiary group-data-[focus]:text-white transition-colors">
                              <FolderIcon />
                            </span>
                            <span class="ml-3 flex-auto truncate">{item.name}</span>
                            <span class="ml-3 hidden flex-none text-xs text-text-muted group-data-[focus]:text-accent-200">
                              Open
                            </span>
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  )}

                  {query !== '' &&
                    filteredProjects.length === 0 &&
                    filteredActions.length === 0 && (
                      <li class="px-6 py-14 text-center">
                        <span class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-text-tertiary">
                          <SearchIcon />
                        </span>
                        <p class="mt-4 text-sm text-text-secondary">
                          No results found for "{query}"
                        </p>
                        <p class="mt-1 text-xs text-text-muted">
                          Try searching for projects or actions
                        </p>
                      </li>
                    )}
                </ComboboxOptions>
              )}

              <div class="flex items-center justify-between border-t border-surface-border px-4 py-3 text-xs text-text-muted">
                <div class="flex items-center gap-4">
                  <span class="flex items-center gap-1">
                    <kbd class="px-1 py-0.5 bg-surface-3 border border-surface-border rounded font-mono">
                      ↑↓
                    </kbd>
                    <span>Navigate</span>
                  </span>
                  <span class="flex items-center gap-1">
                    <kbd class="px-1 py-0.5 bg-surface-3 border border-surface-border rounded font-mono">
                      ↵
                    </kbd>
                    <span>Select</span>
                  </span>
                  <span class="flex items-center gap-1">
                    <kbd class="px-1 py-0.5 bg-surface-3 border border-surface-border rounded font-mono">
                      esc
                    </kbd>
                    <span>Close</span>
                  </span>
                </div>
                <div class="flex items-center gap-1">
                  <CommandIcon />
                  <span>Powered by @hyperneo/ui</span>
                </div>
              </div>
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

export { CommandPaletteDemo };
