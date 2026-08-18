import { useState } from 'preact/hooks';
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Dialog,
  DialogBackdrop,
  DialogPanel,
} from '../../../src/mod.ts';
import { classNames } from '../../../src/internal/class-names.ts';
import {
  ChevronRight,
  Columns3,
  FilePlus,
  Folder,
  FolderPlus,
  Globe,
  Hash,
  HelpCircle,
  Image,
  Link,
  MessageSquare,
  PencilLine,
  Plus,
  Search,
  Table,
  Tag,
  User,
  Users,
  Video,
  X,
} from 'lucide-preact';

interface Person {
  id: number;
  name: string;
  url: string;
}

interface Project {
  id: number;
  name: string;
  category: string;
  url: string;
}

interface QuickAction {
  name: string;
  icon: typeof FilePlus;
  shortcut: string;
  url: string;
}

interface InsertItem {
  id: number;
  name: string;
  description: string;
  url: string;
  color: string;
  icon: typeof PencilLine;
}

interface User {
  id: number;
  name: string;
  url: string;
  imageUrl: string;
}

interface Contact {
  id: number;
  name: string;
  phone: string;
  email: string;
  role: string;
  url: string;
  profileUrl: string;
  imageUrl: string;
}

interface GroupedItem {
  id: number;
  name: string;
  category: string;
  url: string;
}

type SearchResult = Project | User;

const people: Person[] = [
  { id: 1, name: 'Leslie Alexander', url: '#' },
  { id: 2, name: 'Michael Foster', url: '#' },
  { id: 3, name: 'Dries Vincent', url: '#' },
  { id: 4, name: 'Lindsay Walton', url: '#' },
  { id: 5, name: 'Courtney Henry', url: '#' },
  { id: 6, name: 'Tom Cook', url: '#' },
  { id: 7, name: 'Whitney Francis', url: '#' },
  { id: 8, name: 'Leonard Krasner', url: '#' },
  { id: 9, name: 'Flo Fox', url: '#' },
  { id: 10, name: 'Quinn Hatter', url: '#' },
];

const projects: Project[] = [
  { id: 1, name: 'Workflow Inc. / Website Redesign', category: 'Projects', url: '#' },
  { id: 2, name: 'GraphQL API Integration', category: 'Projects', url: '#' },
  { id: 3, name: 'iOS App Development', category: 'Projects', url: '#' },
  { id: 4, name: 'Customer Portal Redesign', category: 'Projects', url: '#' },
];

const recent: Project[] = [projects[0]];
const quickActions: QuickAction[] = [
  { name: 'Add new file...', icon: FilePlus, shortcut: 'N', url: '#' },
  { name: 'Add new folder...', icon: FolderPlus, shortcut: 'F', url: '#' },
  { name: 'Add hashtag...', icon: Hash, shortcut: 'H', url: '#' },
  { name: 'Add label...', icon: Tag, shortcut: 'L', url: '#' },
];

const insertItems: InsertItem[] = [
  {
    id: 1,
    name: 'Text',
    description: 'Add freeform text with basic formatting options.',
    url: '#',
    color: 'bg-accent-500',
    icon: PencilLine,
  },
  {
    id: 2,
    name: 'Image',
    description: 'Upload or embed an image from your files.',
    url: '#',
    color: 'bg-pink-500',
    icon: Image,
  },
  {
    id: 3,
    name: 'Video',
    description: 'Embed a video from YouTube, Vimeo, or upload.',
    url: '#',
    color: 'bg-orange-500',
    icon: Video,
  },
  {
    id: 4,
    name: 'Table',
    description: 'Add a table with custom rows and columns.',
    url: '#',
    color: 'bg-green-500',
    icon: Table,
  },
  {
    id: 5,
    name: 'Code',
    description: 'Add a code snippet with syntax highlighting.',
    url: '#',
    color: 'bg-cyan-500',
    icon: Link,
  },
  {
    id: 6,
    name: 'Columns',
    description: 'Divide content into multi-column layouts.',
    url: '#',
    color: 'bg-violet-500',
    icon: Columns3,
  },
  {
    id: 7,
    name: 'Link',
    description: 'Embed a link with a preview card.',
    url: '#',
    color: 'bg-blue-500',
    icon: Link,
  },
  {
    id: 8,
    name: 'Quote',
    description: 'Add a blockquote with styling options.',
    url: '#',
    color: 'bg-yellow-500',
    icon: MessageSquare,
  },
];

const users: User[] = [
  {
    id: 1,
    name: 'Leslie Alexander',
    url: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 2,
    name: 'Michael Foster',
    url: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 3,
    name: 'Dries Vincent',
    url: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

const contacts: Contact[] = [
  {
    id: 1,
    name: 'Leslie Alexander',
    phone: '1-493-747-9031',
    email: 'lesliealexander@example.com',
    role: 'Co-Founder / CEO',
    url: 'https://example.com',
    profileUrl: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 2,
    name: 'Michael Foster',
    phone: '1-493-747-9032',
    email: 'michaelfoster@example.com',
    role: 'Co-Founder / CTO',
    url: 'https://example.com',
    profileUrl: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 3,
    name: 'Dries Vincent',
    phone: '1-493-747-9033',
    email: 'driesvincent@example.com',
    role: 'Manager, Partnerships',
    url: 'https://example.com',
    profileUrl: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

const recentSearches: Contact[] = [contacts[0], contacts[0], contacts[0], contacts[0], contacts[0]];

const items: GroupedItem[] = [
  { id: 1, name: 'Workflow Inc.', category: 'Clients', url: '#' },
  { id: 2, name: 'Workcation', category: 'Clients', url: '#' },
  { id: 3, name: 'Tailwind Labs', category: 'Clients', url: '#' },
  { id: 4, name: 'Phobia', category: 'Clients', url: '#' },
  { id: 5, name: 'Website Redesign', category: 'Projects', url: '#' },
  { id: 6, name: 'GraphQL API', category: 'Projects', url: '#' },
  { id: 7, name: 'iOS App', category: 'Projects', url: '#' },
  { id: 8, name: 'Customer Portal', category: 'Projects', url: '#' },
];

function SimpleCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredPeople =
    query === ''
      ? []
      : people.filter((person) => person.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Search people...
        <kbd class="ml-4 rounded border border-surface-border px-1.5 text-xs">⌘K</kbd>
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-0 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(person: Person) => {
                if (person) {
                  window.location.href = person.url;
                }
              }}
            >
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-12 w-full pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-surface-2 dark:text-white"
                  placeholder="Search..."
                  onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                  onBlur={() => setQuery('')}
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                />
              </div>

              {filteredPeople.length > 0 && (
                <ComboboxOptions
                  static
                  class="max-h-72 scroll-py-2 overflow-y-auto py-2 text-sm text-text-secondary"
                >
                  {filteredPeople.map((person) => (
                    <ComboboxOption
                      key={person.id}
                      value={person}
                      class="cursor-default px-4 py-2 select-none data-focus:bg-accent-500 data-focus:text-white data-focus:outline-hidden dark:data-focus:bg-accent-500"
                    >
                      {person.name}
                    </ComboboxOption>
                  ))}
                </ComboboxOptions>
              )}

              {query !== '' && filteredPeople.length === 0 && (
                <p class="p-4 text-sm text-text-tertiary">No people found.</p>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function SimpleWithPaddingCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredPeople =
    query === ''
      ? []
      : people.filter((person) => person.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Search...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-xl transform rounded-xl bg-surface-0 p-2 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(person: Person) => {
                if (person) {
                  window.location.href = person.url;
                }
              }}
            >
              <ComboboxInput
                autoFocus
                class="w-full rounded-md bg-surface-1 px-4 py-2.5 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-white/5 dark:text-white dark:placeholder:text-text-tertiary"
                placeholder="Search..."
                onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                onBlur={() => setQuery('')}
              />

              {filteredPeople.length > 0 && (
                <ComboboxOptions
                  static
                  class="-mb-2 max-h-72 scroll-py-2 overflow-y-auto py-2 text-sm text-text-secondary dark:text-gray-200"
                >
                  {filteredPeople.map((person) => (
                    <ComboboxOption
                      key={person.id}
                      value={person}
                      class="cursor-default rounded-md px-4 py-2 select-none data-focus:bg-accent-500 data-focus:text-white data-focus:outline-hidden dark:data-focus:bg-accent-500"
                    >
                      {person.name}
                    </ComboboxOption>
                  ))}
                </ComboboxOptions>
              )}

              {query !== '' && filteredPeople.length === 0 && (
                <div class="px-4 py-14 text-center sm:px-14">
                  <Users class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                  <p class="mt-4 text-sm text-text-primary dark:text-gray-200">
                    No people found using that search term.
                  </p>
                </div>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function WithPreviewCommandPalette() {
  const [open, setOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState('');

  const query = rawQuery.toLowerCase().replace(/^[#>]/, '');

  const filteredProjects =
    rawQuery === '#'
      ? projects
      : query === '' || rawQuery.startsWith('>')
        ? []
        : projects.filter((project) => project.name.toLowerCase().includes(query));

  const filteredUsers =
    rawQuery === '>'
      ? users
      : query === '' || rawQuery.startsWith('#')
        ? []
        : users.filter((user) => user.name.toLowerCase().includes(query));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Search...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setRawQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-0 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(item: SearchResult) => {
                if (item) {
                  window.location.href = item.url;
                }
              }}
            >
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-12 w-full pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-surface-2 dark:text-white dark:placeholder:text-text-tertiary"
                  placeholder="Search..."
                  onChange={(event) => setRawQuery((event.target as HTMLInputElement).value)}
                  onBlur={() => setRawQuery('')}
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                />
              </div>

              {(filteredProjects.length > 0 || filteredUsers.length > 0) && (
                <ComboboxOptions
                  static
                  as="ul"
                  class="max-h-80 transform-gpu scroll-py-10 scroll-pb-2 space-y-4 overflow-y-auto p-4 pb-2"
                >
                  {filteredProjects.length > 0 && (
                    <li>
                      <h2 class="text-xs font-semibold text-text-primary">Projects</h2>
                      <ul class="-mx-4 mt-2 text-sm text-text-secondary">
                        {filteredProjects.map((project) => (
                          <ComboboxOption
                            as="li"
                            key={project.id}
                            value={project}
                            class="group flex cursor-default items-center px-4 py-2 select-none data-focus:bg-accent-500 data-focus:text-white data-focus:outline-hidden dark:data-focus:bg-accent-500"
                          >
                            <Folder
                              class="size-6 flex-none text-text-tertiary group-data-focus:text-white"
                              aria-hidden="true"
                            />
                            <span class="ml-3 flex-auto truncate">{project.name}</span>
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  )}
                  {filteredUsers.length > 0 && (
                    <li>
                      <h2 class="text-xs font-semibold text-text-primary">Users</h2>
                      <ul class="-mx-4 mt-2 text-sm text-text-secondary">
                        {filteredUsers.map((user) => (
                          <ComboboxOption
                            as="li"
                            key={user.id}
                            value={user}
                            class="flex cursor-default items-center px-4 py-2 select-none data-focus:bg-accent-500 data-focus:text-white dark:data-focus:bg-accent-500"
                          >
                            <img
                              src={user.imageUrl}
                              alt=""
                              class="size-6 flex-none rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                            />
                            <span class="ml-3 flex-auto truncate">{user.name}</span>
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  )}
                </ComboboxOptions>
              )}

              {rawQuery === '?' && (
                <div class="px-6 py-14 text-center text-sm sm:px-14">
                  <HelpCircle class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                  <p class="mt-4 font-semibold text-text-primary">Help with searching</p>
                  <p class="mt-2 text-text-tertiary">
                    Use this tool to quickly search for users and projects across our entire
                    platform. You can also use the search modifiers found in the footer below to
                    limit the results to just users or projects.
                  </p>
                </div>
              )}

              {query !== '' &&
                rawQuery !== '?' &&
                filteredProjects.length === 0 &&
                filteredUsers.length === 0 && (
                  <div class="px-6 py-14 text-center text-sm sm:px-14">
                    <X class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                    <p class="mt-4 font-semibold text-text-primary">No results found</p>
                    <p class="mt-2 text-text-tertiary">
                      We couldn't find anything with that term. Please try again.
                    </p>
                  </div>
                )}

              <div class="flex flex-wrap items-center bg-surface-1 px-4 py-2.5 text-xs text-text-tertiary dark:bg-surface-2/50 dark:text-gray-300">
                Type{' '}
                <kbd
                  class={classNames(
                    'mx-1 flex size-5 items-center justify-center rounded-sm border bg-surface-0 font-semibold sm:mx-2 dark:bg-surface-2',
                    rawQuery.startsWith('#')
                      ? 'border-accent-500 text-accent-500'
                      : 'border-surface-border text-text-primary'
                  )}
                >
                  #
                </kbd>{' '}
                <span class="hidden sm:inline">to access projects,</span>
                <span class="sm:hidden">for projects,</span>
                <kbd
                  class={classNames(
                    'mx-1 flex size-5 items-center justify-center rounded-sm border bg-surface-0 font-semibold sm:mx-2 dark:bg-surface-2',
                    rawQuery.startsWith('>')
                      ? 'border-accent-500 text-accent-500'
                      : 'border-surface-border text-text-primary'
                  )}
                >
                  &gt;
                </kbd>{' '}
                for users, and{' '}
                <kbd
                  class={classNames(
                    'mx-1 flex size-5 items-center justify-center rounded-sm border bg-surface-0 font-semibold sm:mx-2 dark:bg-surface-2',
                    rawQuery === '?'
                      ? 'border-accent-500 text-accent-500'
                      : 'border-surface-border text-text-primary'
                  )}
                >
                  ?
                </kbd>{' '}
                for help.
              </div>
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function WithImagesAndDescriptionsCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredItems =
    query === ''
      ? []
      : insertItems.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Plus class="size-4" />
        Insert content...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-0 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(item: InsertItem) => {
                if (item) {
                  window.location.href = item.url;
                }
              }}
            >
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-12 w-full pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-surface-2 dark:text-white dark:placeholder:text-text-tertiary"
                  placeholder="Search..."
                  onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                  onBlur={() => setQuery('')}
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                />
              </div>

              {filteredItems.length > 0 && (
                <ComboboxOptions
                  static
                  class="max-h-96 transform-gpu scroll-py-3 overflow-y-auto p-3"
                >
                  {filteredItems.map((item) => (
                    <ComboboxOption
                      key={item.id}
                      value={item}
                      class="group flex cursor-default rounded-xl p-3 select-none data-focus:bg-surface-1 data-focus:outline-hidden dark:data-focus:bg-white/5"
                    >
                      <div
                        class={classNames(
                          'flex size-10 flex-none items-center justify-center rounded-lg',
                          item.color
                        )}
                      >
                        <item.icon class="size-6 text-white" aria-hidden="true" />
                      </div>
                      <div class="ml-4 flex-auto">
                        <p class="text-sm font-medium text-text-secondary group-data-focus:text-text-primary dark:text-gray-300 dark:group-data-focus:text-white">
                          {item.name}
                        </p>
                        <p class="text-sm text-text-tertiary group-data-focus:text-text-secondary dark:text-gray-400 dark:group-data-focus:text-gray-300">
                          {item.description}
                        </p>
                      </div>
                    </ComboboxOption>
                  ))}
                </ComboboxOptions>
              )}

              {query !== '' && filteredItems.length === 0 && (
                <div class="px-6 py-14 text-center text-sm sm:px-14">
                  <X class="mx-auto size-6 text-text-tertiary" />
                  <p class="mt-4 font-semibold text-text-primary">No results found</p>
                  <p class="mt-2 text-text-tertiary">
                    No components found for this search term. Please try again.
                  </p>
                </div>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function WithIconsCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredProjects =
    query === ''
      ? []
      : projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Search projects...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-2xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-0 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(item: Project) => {
                if (item) {
                  window.location.href = item.url;
                }
              }}
            >
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-12 w-full pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-surface-2 dark:text-white dark:placeholder:text-text-tertiary"
                  placeholder="Search..."
                  onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                  onBlur={() => setQuery('')}
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                />
              </div>

              {(query === '' || filteredProjects.length > 0) && (
                <ComboboxOptions
                  static
                  as="ul"
                  class="max-h-80 scroll-py-2 divide-y divide-surface-border overflow-y-auto dark:divide-white/10"
                >
                  <li class="p-2">
                    {query === '' && (
                      <h2 class="mt-4 mb-2 px-3 text-xs font-semibold text-text-tertiary">
                        Recent searches
                      </h2>
                    )}
                    <ul class="text-sm text-text-secondary">
                      {(query === '' ? recent : filteredProjects).map((project) => (
                        <ComboboxOption
                          as="li"
                          key={project.id}
                          value={project}
                          class="group flex cursor-default items-center rounded-md px-3 py-2 select-none data-focus:bg-accent-500 data-focus:text-white data-focus:outline-hidden dark:data-focus:bg-accent-500"
                        >
                          <Folder
                            class="size-6 flex-none text-text-tertiary group-data-focus:text-white"
                            aria-hidden="true"
                          />
                          <span class="ml-3 flex-auto truncate">{project.name}</span>
                          <span class="ml-3 hidden flex-none text-accent-500 group-data-focus:inline">
                            Jump to...
                          </span>
                        </ComboboxOption>
                      ))}
                    </ul>
                  </li>
                  {query === '' && (
                    <li class="p-2">
                      <h2 class="sr-only">Quick actions</h2>
                      <ul class="text-sm text-text-secondary">
                        {quickActions.map((action) => (
                          <ComboboxOption
                            as="li"
                            key={action.shortcut}
                            value={action}
                            class="group flex cursor-default items-center rounded-md px-3 py-2 select-none data-focus:bg-accent-500 data-focus:text-white data-focus:outline-hidden dark:data-focus:bg-accent-500"
                          >
                            <action.icon
                              class="size-6 flex-none text-text-tertiary group-data-focus:text-white"
                              aria-hidden="true"
                            />
                            <span class="ml-3 flex-auto truncate">{action.name}</span>
                            <span class="ml-3 flex-none text-xs font-semibold text-text-tertiary group-data-focus:text-white">
                              <kbd class="font-sans">⌘</kbd>
                              <kbd class="font-sans">{action.shortcut}</kbd>
                            </span>
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  )}
                </ComboboxOptions>
              )}

              {query !== '' && filteredProjects.length === 0 && (
                <div class="px-6 py-14 text-center sm:px-14">
                  <Folder class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                  <p class="mt-4 text-sm text-text-primary">
                    We couldn't find any projects with that term. Please try again.
                  </p>
                </div>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function SemiTransparentWithIconsCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredProjects =
    query === ''
      ? []
      : projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Search...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-2xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-0/80 shadow-2xl outline outline-black/5 backdrop-blur-sm transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:divide-white/10 dark:bg-surface-2/80 dark:outline-white/10"
          >
            <Combobox
              onChange={(item: Project) => {
                if (item) {
                  window.location.href = item.url;
                }
              }}
            >
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-12 w-full bg-transparent pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:text-white dark:placeholder:text-text-tertiary"
                  placeholder="Search..."
                  onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                  onBlur={() => setQuery('')}
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                />
              </div>

              {(query === '' || filteredProjects.length > 0) && (
                <ComboboxOptions
                  static
                  as="ul"
                  class="max-h-80 scroll-py-2 divide-y divide-surface-border overflow-y-auto dark:divide-white/10"
                >
                  <li class="p-2">
                    {query === '' && (
                      <h2 class="mt-4 mb-2 px-3 text-xs font-semibold text-text-primary">
                        Recent searches
                      </h2>
                    )}
                    <ul class="text-sm text-text-secondary">
                      {(query === '' ? recent : filteredProjects).map((project) => (
                        <ComboboxOption
                          as="li"
                          key={project.id}
                          value={project}
                          class="group flex cursor-default items-center rounded-md px-3 py-2 select-none data-focus:bg-black/5 data-focus:text-text-primary data-focus:outline-hidden dark:data-focus:bg-white/5 dark:data-focus:text-white"
                        >
                          <Folder
                            class="size-6 flex-none text-text-tertiary group-data-focus:text-text-primary dark:text-gray-500 dark:group-data-focus:text-white"
                            aria-hidden="true"
                          />
                          <span class="ml-3 flex-auto truncate">{project.name}</span>
                          <span class="ml-3 hidden flex-none text-text-tertiary group-data-focus:inline dark:text-gray-400">
                            Jump to...
                          </span>
                        </ComboboxOption>
                      ))}
                    </ul>
                  </li>
                  {query === '' && (
                    <li class="p-2">
                      <h2 class="sr-only">Quick actions</h2>
                      <ul class="text-sm text-text-secondary">
                        {quickActions.map((action) => (
                          <ComboboxOption
                            as="li"
                            key={action.shortcut}
                            value={action}
                            class="group flex cursor-default items-center rounded-md px-3 py-2 select-none data-focus:bg-black/5 data-focus:text-text-primary data-focus:outline-hidden dark:data-focus:bg-white/5 dark:data-focus:text-white"
                          >
                            <action.icon
                              class="size-6 flex-none text-text-tertiary group-data-focus:text-text-primary dark:text-gray-500 dark:group-data-focus:text-white"
                              aria-hidden="true"
                            />
                            <span class="ml-3 flex-auto truncate">{action.name}</span>
                            <span class="ml-3 flex-none text-xs font-semibold text-text-tertiary group-data-focus:text-text-primary dark:text-gray-400 dark:group-data-focus:text-white">
                              <kbd class="font-sans">⌘</kbd>
                              <kbd class="font-sans">{action.shortcut}</kbd>
                            </span>
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  )}
                </ComboboxOptions>
              )}

              {query !== '' && filteredProjects.length === 0 && (
                <div class="px-6 py-14 text-center sm:px-14">
                  <Folder class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                  <p class="mt-4 text-sm text-text-primary">
                    We couldn't find any projects with that term. Please try again.
                  </p>
                </div>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function WithGroupsCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredItems =
    query === ''
      ? []
      : items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));

  const groups = filteredItems.reduce(
    (groups, item) => {
      return { ...groups, [item.category]: [...(groups[item.category] || []), item] };
    },
    {} as Record<string, typeof items>
  );

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Search...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-xl transform overflow-hidden rounded-xl bg-surface-0 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(item: GroupedItem) => {
                if (item) {
                  window.location.href = item.url;
                }
              }}
            >
              <div class="grid grid-cols-1">
                <ComboboxInput
                  autoFocus
                  class="col-start-1 row-start-1 h-12 w-full pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-surface-2 dark:text-white dark:placeholder:text-text-tertiary"
                  placeholder="Search..."
                  onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                  onBlur={() => setQuery('')}
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                />
              </div>

              {query === '' && (
                <div class="border-t border-surface-border px-6 py-14 text-center text-sm dark:border-white/10">
                  <Globe class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                  <p class="mt-4 font-semibold text-text-primary">
                    Search for clients and projects
                  </p>
                  <p class="mt-2 text-text-tertiary">
                    Quickly access clients and projects by running a global search.
                  </p>
                </div>
              )}

              {filteredItems.length > 0 && (
                <ComboboxOptions
                  static
                  as="ul"
                  class="max-h-80 scroll-pt-11 scroll-pb-2 space-y-2 overflow-y-auto pb-2"
                >
                  {Object.entries(groups).map(([category, categoryItems]) => (
                    <li key={category}>
                      <h2 class="bg-surface-1 px-4 py-2.5 text-xs font-semibold text-text-primary dark:bg-white/5 dark:text-white">
                        {category}
                      </h2>
                      <ul class="mt-2 text-sm text-text-secondary">
                        {categoryItems.map((item) => (
                          <ComboboxOption
                            key={item.id}
                            value={item}
                            class="cursor-default px-4 py-2 select-none data-focus:bg-accent-500 data-focus:text-white data-focus:outline-hidden dark:data-focus:bg-accent-500"
                          >
                            {item.name}
                          </ComboboxOption>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ComboboxOptions>
              )}

              {query !== '' && filteredItems.length === 0 && (
                <div class="border-t border-surface-border px-6 py-14 text-center text-sm dark:border-white/10">
                  <X class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                  <p class="mt-4 font-semibold text-text-primary">No results found</p>
                  <p class="mt-2 text-text-tertiary">
                    We couldn't find anything with that term. Please try again.
                  </p>
                </div>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function WithFooterCommandPalette() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filteredPeople =
    query === ''
      ? []
      : contacts.filter((person) => person.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="mx-auto flex items-center gap-x-2 rounded-md bg-surface-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 dark:bg-surface-2 dark:hover:bg-white/5"
      >
        <Search class="size-4" />
        Find contacts...
      </button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setQuery('');
        }}
        class="relative z-10"
      >
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/25 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-black/50"
        />

        <div class="fixed inset-0 z-10 w-screen overflow-y-auto p-4 sm:p-6 md:p-20">
          <DialogPanel
            transition
            class="mx-auto max-w-3xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-0 shadow-2xl outline outline-black/5 transition-all data-closed:scale-95 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in dark:bg-surface-2 dark:outline-white/10"
          >
            <Combobox
              onChange={(person: Person) => {
                if (person) {
                  window.location.href = person.url;
                }
              }}
            >
              {({ activeOption }: { activeOption?: (typeof contacts)[0] }) => (
                <>
                  <div class="grid grid-cols-1">
                    <ComboboxInput
                      autoFocus
                      class="col-start-1 row-start-1 h-12 w-full pr-4 pl-11 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm dark:bg-surface-2 dark:text-white dark:placeholder:text-text-tertiary"
                      placeholder="Search..."
                      onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
                      onBlur={() => setQuery('')}
                    />
                    <Search
                      aria-hidden="true"
                      class="pointer-events-none col-start-1 row-start-1 ml-4 size-5 self-center text-text-tertiary"
                    />
                  </div>

                  {(query === '' || filteredPeople.length > 0) && (
                    <ComboboxOptions
                      as="div"
                      static
                      class="flex transform-gpu divide-x divide-surface-border dark:divide-white/10"
                    >
                      <div
                        class={classNames(
                          'max-h-96 min-w-0 flex-auto scroll-py-4 overflow-y-auto px-6 py-4',
                          activeOption && 'sm:h-96'
                        )}
                      >
                        {query === '' && (
                          <h2 class="mt-2 mb-4 text-xs font-semibold text-text-tertiary">
                            Recent searches
                          </h2>
                        )}
                        <div class="-mx-2 text-sm text-text-secondary">
                          {(query === '' ? recentSearches : filteredPeople).map((person) => (
                            <ComboboxOption
                              as="div"
                              key={person.id}
                              value={person}
                              class="group flex cursor-default items-center rounded-md p-2 select-none data-focus:bg-surface-1 data-focus:text-text-primary data-focus:outline-hidden dark:data-focus:bg-white/5 dark:data-focus:text-white"
                            >
                              <img
                                src={person.imageUrl}
                                alt=""
                                class="size-6 flex-none rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                              />
                              <span class="ml-3 flex-auto truncate">{person.name}</span>
                              <ChevronRight
                                class="ml-3 hidden size-5 flex-none text-text-tertiary group-data-focus:block dark:text-gray-500"
                                aria-hidden="true"
                              />
                            </ComboboxOption>
                          ))}
                        </div>
                      </div>

                      {activeOption && (
                        <div class="hidden h-96 w-1/2 flex-none flex-col divide-y divide-surface-border overflow-y-auto sm:flex dark:divide-white/10">
                          <div class="flex-none p-6 text-center">
                            <img
                              src={activeOption.imageUrl}
                              alt=""
                              class="mx-auto size-16 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                            />
                            <h2 class="mt-3 font-semibold text-text-primary">
                              {activeOption.name}
                            </h2>
                            <p class="text-sm/6 text-text-tertiary">{activeOption.role}</p>
                          </div>
                          <div class="flex flex-auto flex-col justify-between p-6">
                            <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm text-text-secondary">
                              <dt class="col-end-1 font-semibold text-text-primary">Phone</dt>
                              <dd>{activeOption.phone}</dd>
                              <dt class="col-end-1 font-semibold text-text-primary">URL</dt>
                              <dd class="truncate">
                                <a href={activeOption.url} class="text-accent-500 underline">
                                  {activeOption.url}
                                </a>
                              </dd>
                              <dt class="col-end-1 font-semibold text-text-primary">Email</dt>
                              <dd class="truncate">
                                <a
                                  href={`mailto:${activeOption.email}`}
                                  class="text-accent-500 underline"
                                >
                                  {activeOption.email}
                                </a>
                              </dd>
                            </dl>
                            <button
                              type="button"
                              class="mt-6 w-full rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                            >
                              Send message
                            </button>
                          </div>
                        </div>
                      )}
                    </ComboboxOptions>
                  )}

                  {query !== '' && filteredPeople.length === 0 && (
                    <div class="px-6 py-14 text-center text-sm sm:px-14">
                      <Users class="mx-auto size-6 text-text-tertiary" aria-hidden="true" />
                      <p class="mt-4 font-semibold text-text-primary">No people found</p>
                      <p class="mt-2 text-text-tertiary">
                        We couldn't find anything with that term. Please try again.
                      </p>
                    </div>
                  )}
                </>
              )}
            </Combobox>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

export function CommandPalettesDemo() {
  return (
    <div class="flex flex-col gap-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <SimpleCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple with padding</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <SimpleWithPaddingCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With preview</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <WithPreviewCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With images and descriptions</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <WithImagesAndDescriptionsCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With icons</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <WithIconsCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Semi-transparent with icons</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-1/50 p-8 dark:bg-surface-2/50">
          <SemiTransparentWithIconsCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With groups</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <WithGroupsCommandPalette />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With footer</h3>
        <div class="flex justify-center rounded-lg border border-surface-border bg-surface-0 p-8 dark:bg-surface-2">
          <WithFooterCommandPalette />
        </div>
      </div>
    </div>
  );
}
