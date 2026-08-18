import { useState } from 'preact/hooks';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
} from '../../../../src/mod.ts';
import {
  Bell,
  Calendar,
  ChartPie,
  ChevronDown,
  Files,
  Folder,
  Home,
  Menu as MenuIcon,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-preact';
import { classNames } from '../../../../src/internal/class-names.ts';

const navigation = [
  { name: 'Dashboard', href: '#', icon: Home, current: true },
  { name: 'Team', href: '#', icon: Users, current: false },
  { name: 'Projects', href: '#', icon: Folder, current: false },
  { name: 'Calendar', href: '#', icon: Calendar, current: false },
  { name: 'Documents', href: '#', icon: Files, current: false },
  { name: 'Reports', href: '#', icon: ChartPie, current: false },
];
const teams = [
  { id: 1, name: 'Heroicons', href: '#', initial: 'H', current: false },
  { id: 2, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  { id: 3, name: 'Workcation', href: '#', initial: 'W', current: false },
];
const userNavigation = [
  { name: 'Your profile', href: '#' },
  { name: 'Sign out', href: '#' },
];

function SimpleSidebar() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div>
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 lg:hidden">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
        />

        <div class="fixed inset-0 flex">
          <DialogPanel
            transition
            class="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:-translate-x-full"
          >
            <div class="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
              <button type="button" onClick={() => setSidebarOpen(false)} class="-m-2.5 p-2.5">
                <span class="sr-only">Close sidebar</span>
                <X aria-hidden="true" class="size-6 text-white" />
              </button>
            </div>

            <div class="flex grow flex-col gap-y-5 overflow-y-auto bg-accent-600 px-6 pb-2 dark:bg-accent-800 dark:ring-1 dark:ring-white/10">
              <div class="flex h-16 shrink-0 items-center">
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=white"
                  class="h-8 w-auto dark:hidden"
                />
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=white"
                  class="h-8 w-auto hidden dark:block"
                />
              </div>
              <nav class="flex flex-1 flex-col">
                <ul role="list" class="flex flex-1 flex-col gap-y-7">
                  <li>
                    <ul role="list" class="-mx-2 space-y-1">
                      {navigation.map((item) => (
                        <li key={item.name}>
                          <a
                            href={item.href}
                            class={classNames(
                              item.current
                                ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                                : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <item.icon
                              aria-hidden="true"
                              class={classNames(
                                item.current
                                  ? 'text-white'
                                  : 'text-accent-200 group-hover:text-white dark:text-accent-100',
                                'size-6 shrink-0'
                              )}
                            />
                            {item.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <div class="text-xs/6 font-semibold text-accent-200 dark:text-accent-100">
                      Your teams
                    </div>
                    <ul role="list" class="-mx-2 mt-2 space-y-1">
                      {teams.map((team) => (
                        <li key={team.name}>
                          <a
                            href={team.href}
                            class={classNames(
                              team.current
                                ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                                : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-accent-400 bg-accent-500 text-[0.625rem] font-medium text-white dark:border-accent-500/50 dark:bg-accent-700">
                              {team.initial}
                            </span>
                            <span class="truncate">{team.name}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                </ul>
              </nav>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
        <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-accent-600 px-6 dark:bg-accent-800 dark:after:pointer-events-none dark:after:absolute dark:after:inset-y-0 dark:after:right-0 dark:after:w-px dark:after:bg-white/10">
          <div class="flex h-16 shrink-0 items-center">
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=white"
              class="h-8 w-auto dark:hidden"
            />
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=white"
              class="h-8 w-auto hidden dark:block"
            />
          </div>
          <nav class="flex flex-1 flex-col">
            <ul role="list" class="flex flex-1 flex-col gap-y-7">
              <li>
                <ul role="list" class="-mx-2 space-y-1">
                  {navigation.map((item) => (
                    <li key={item.name}>
                      <a
                        href={item.href}
                        class={classNames(
                          item.current
                            ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                            : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <item.icon
                          aria-hidden="true"
                          class={classNames(
                            item.current
                              ? 'text-white'
                              : 'text-accent-200 group-hover:text-white dark:text-accent-100',
                            'size-6 shrink-0'
                          )}
                        />
                        {item.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li>
                <div class="text-xs/6 font-semibold text-accent-200 dark:text-accent-100">
                  Your teams
                </div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                            : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-accent-400 bg-accent-500 text-[0.625rem] font-medium text-white dark:border-accent-500/50 dark:bg-accent-700">
                          {team.initial}
                        </span>
                        <span class="truncate">{team.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li class="-mx-6 mt-auto">
                <a
                  href="#"
                  class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-white hover:bg-accent-700 dark:hover:bg-accent-950/25"
                >
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-accent-700 outline -outline-offset-1 outline-white/10 dark:bg-accent-800"
                  />
                  <span class="sr-only">Your profile</span>
                  <span aria-hidden="true">Tom Cook</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-accent-600 px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-accent-800 dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          class="-m-2.5 p-2.5 text-accent-200 hover:text-white lg:hidden"
        >
          <span class="sr-only">Open sidebar</span>
          <MenuIcon aria-hidden="true" class="size-6" />
        </button>
        <div class="flex-1 text-sm/6 font-semibold text-white">Dashboard</div>
        <a href="#">
          <span class="sr-only">Your profile</span>
          <img
            alt=""
            src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
            class="size-8 rounded-full bg-accent-700 outline -outline-offset-1 outline-white/10 dark:bg-accent-800"
          />
        </a>
      </div>

      <main class="py-10 lg:pl-72">
        <div class="px-4 sm:px-6 lg:px-8"></div>
      </main>
    </div>
  );
}

function DarkSidebarWithHeader() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div>
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 lg:hidden">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
        />

        <div class="fixed inset-0 flex">
          <DialogPanel
            transition
            class="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:-translate-x-full"
          >
            <div class="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
              <button type="button" onClick={() => setSidebarOpen(false)} class="-m-2.5 p-2.5">
                <span class="sr-only">Close sidebar</span>
                <X aria-hidden="true" class="size-6 text-white" />
              </button>
            </div>

            <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-accent-600 px-6 pb-4 dark:bg-accent-800 dark:ring-1 dark:ring-white/10">
              <div class="flex h-16 shrink-0 items-center">
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=white"
                  class="h-8 w-auto"
                />
              </div>
              <nav class="flex flex-1 flex-col">
                <ul role="list" class="flex flex-1 flex-col gap-y-7">
                  <li>
                    <ul role="list" class="-mx-2 space-y-1">
                      {navigation.map((item) => (
                        <li key={item.name}>
                          <a
                            href={item.href}
                            class={classNames(
                              item.current
                                ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                                : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <item.icon
                              aria-hidden="true"
                              class={classNames(
                                item.current
                                  ? 'text-white'
                                  : 'text-accent-200 group-hover:text-white dark:text-accent-100',
                                'size-6 shrink-0'
                              )}
                            />
                            {item.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <div class="text-xs/6 font-semibold text-accent-200 dark:text-accent-100">
                      Your teams
                    </div>
                    <ul role="list" class="-mx-2 mt-2 space-y-1">
                      {teams.map((team) => (
                        <li key={team.name}>
                          <a
                            href={team.href}
                            class={classNames(
                              team.current
                                ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                                : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-accent-400 bg-accent-500 text-[0.625rem] font-medium text-white dark:border-accent-500/50 dark:bg-accent-700">
                              {team.initial}
                            </span>
                            <span class="truncate">{team.name}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li class="mt-auto">
                    <a
                      href="#"
                      class="group -mx-2 flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25"
                    >
                      <Settings
                        aria-hidden="true"
                        class="size-6 shrink-0 text-accent-200 group-hover:text-white dark:text-accent-100"
                      />
                      Settings
                    </a>
                  </li>
                </ul>
              </nav>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
        <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-accent-600 px-6 pb-4 dark:bg-accent-800 dark:after:pointer-events-none dark:after:absolute dark:after:inset-y-0 dark:after:right-0 dark:after:w-px dark:after:bg-white/10">
          <div class="flex h-16 shrink-0 items-center">
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=white"
              class="h-8 w-auto"
            />
          </div>
          <nav class="flex flex-1 flex-col">
            <ul role="list" class="flex flex-1 flex-col gap-y-7">
              <li>
                <ul role="list" class="-mx-2 space-y-1">
                  {navigation.map((item) => (
                    <li key={item.name}>
                      <a
                        href={item.href}
                        class={classNames(
                          item.current
                            ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                            : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <item.icon
                          aria-hidden="true"
                          class={classNames(
                            item.current
                              ? 'text-white'
                              : 'text-accent-200 group-hover:text-white dark:text-accent-100',
                            'size-6 shrink-0'
                          )}
                        />
                        {item.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li>
                <div class="text-xs/6 font-semibold text-accent-200 dark:text-accent-100">
                  Your teams
                </div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-accent-700 text-white dark:bg-accent-950/25'
                            : 'text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-accent-400 bg-accent-500 text-[0.625rem] font-medium text-white dark:border-accent-500/50 dark:bg-accent-700">
                          {team.initial}
                        </span>
                        <span class="truncate">{team.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li class="mt-auto">
                <a
                  href="#"
                  class="group -mx-2 flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold text-accent-200 hover:bg-accent-700 hover:text-white dark:text-accent-100 dark:hover:bg-accent-950/25"
                >
                  <Settings
                    aria-hidden="true"
                    class="size-6 shrink-0 text-accent-200 group-hover:text-white dark:text-accent-100"
                  />
                  Settings
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="lg:pl-72">
        <div class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-surface-border bg-surface-0 px-4 shadow-xs sm:gap-x-6 sm:px-6 lg:px-8 dark:border-white/10 dark:bg-surface-2 dark:shadow-none">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            class="-m-2.5 p-2.5 text-text-secondary hover:text-text-primary lg:hidden dark:text-text-tertiary dark:hover:text-white"
          >
            <span class="sr-only">Open sidebar</span>
            <MenuIcon aria-hidden="true" class="size-6" />
          </button>

          <div aria-hidden="true" class="h-6 w-px bg-black/10 lg:hidden dark:bg-white/10" />

          <div class="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
            <form action="#" method="GET" class="grid flex-1 grid-cols-1">
              <input
                name="search"
                placeholder="Search"
                aria-label="Search"
                class="col-start-1 row-start-1 block size-full bg-surface-0 pl-8 text-base text-text-primary outline-hidden placeholder:text-text-muted sm:text-sm/6 dark:bg-surface-2 dark:text-white dark:placeholder:text-text-muted"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 size-5 self-center text-text-muted"
              />
            </form>
            <div class="flex items-center gap-x-4 lg:gap-x-6">
              <button
                type="button"
                class="-m-2.5 p-2.5 text-text-muted hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
              >
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <div
                aria-hidden="true"
                class="hidden lg:block lg:h-6 lg:w-px lg:bg-black/10 dark:lg:bg-white/10"
              />

              <Menu as="div" class="relative">
                <MenuButton class="relative flex items-center">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-3 dark:outline-white/10"
                  />
                  <span class="hidden lg:flex lg:items-center">
                    <span
                      aria-hidden="true"
                      class="ml-4 text-sm/6 font-semibold text-text-primary dark:text-white"
                    >
                      Tom Cook
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      class="ml-2 size-5 text-text-muted dark:text-text-tertiary"
                    />
                  </span>
                </MenuButton>
                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2.5 w-32 origin-top-right rounded-md bg-surface-1 py-2 shadow-lg outline outline-surface-border transition data-[closed]:scale-95 data-[closed]:transform data-[closed]:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-3 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                >
                  {userNavigation.map((item) => (
                    <MenuItem key={item.name}>
                      <a
                        href={item.href}
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-surface-2 data-[focus]:outline-hidden dark:text-white dark:data-[focus]:bg-white/5"
                      >
                        {item.name}
                      </a>
                    </MenuItem>
                  ))}
                </MenuItems>
              </Menu>
            </div>
          </div>
        </div>

        <main class="py-10">
          <div class="px-4 sm:px-6 lg:px-8"></div>
        </main>
      </div>
    </div>
  );
}

function LightBrandSidebar() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div>
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 lg:hidden">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
        />

        <div class="fixed inset-0 flex">
          <DialogPanel
            transition
            class="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:-translate-x-full"
          >
            <div class="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
              <button type="button" onClick={() => setSidebarOpen(false)} class="-m-2.5 p-2.5">
                <span class="sr-only">Close sidebar</span>
                <X aria-hidden="true" class="size-6 text-white" />
              </button>
            </div>

            <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-surface-0 px-6 pb-2 dark:bg-surface-2 dark:ring dark:ring-white/10 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
              <div class="relative flex h-16 shrink-0 items-center">
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                  class="h-8 w-auto dark:hidden"
                />
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                  class="h-8 w-auto hidden dark:block"
                />
              </div>
              <nav class="relative flex flex-1 flex-col">
                <ul role="list" class="flex flex-1 flex-col gap-y-7">
                  <li>
                    <ul role="list" class="-mx-2 space-y-1">
                      {navigation.map((item) => (
                        <li key={item.name}>
                          <a
                            href={item.href}
                            class={classNames(
                              item.current
                                ? 'bg-surface-1 text-accent-600 dark:bg-white/5 dark:text-white'
                                : 'text-text-secondary hover:bg-surface-1 hover:text-accent-600 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <item.icon
                              aria-hidden="true"
                              class={classNames(
                                item.current
                                  ? 'text-accent-600 dark:text-white'
                                  : 'text-text-muted group-hover:text-accent-600 dark:group-hover:text-white',
                                'size-6 shrink-0'
                              )}
                            />
                            {item.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <div class="text-xs/6 font-semibold text-text-muted">Your teams</div>
                    <ul role="list" class="-mx-2 mt-2 space-y-1">
                      {teams.map((team) => (
                        <li key={team.name}>
                          <a
                            href={team.href}
                            class={classNames(
                              team.current
                                ? 'bg-surface-1 text-accent-600 dark:bg-white/5 dark:text-white'
                                : 'text-text-secondary hover:bg-surface-1 hover:text-accent-600 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <span
                              class={classNames(
                                team.current
                                  ? 'border-accent-600 text-accent-600 dark:border-white/20 dark:text-white'
                                  : 'border-surface-border text-text-muted group-hover:border-accent-600 group-hover:text-accent-600 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                                'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-white text-[0.625rem] font-medium dark:bg-white/5'
                              )}
                            >
                              {team.initial}
                            </span>
                            <span class="truncate">{team.name}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                </ul>
              </nav>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col dark:bg-surface-2">
        <div class="flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-0 px-6 dark:border-white/10 dark:bg-black/10">
          <div class="flex h-16 shrink-0 items-center">
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
              class="h-8 w-auto dark:hidden"
            />
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
              class="h-8 w-auto hidden dark:block"
            />
          </div>
          <nav class="flex flex-1 flex-col">
            <ul role="list" class="flex flex-1 flex-col gap-y-7">
              <li>
                <ul role="list" class="-mx-2 space-y-1">
                  {navigation.map((item) => (
                    <li key={item.name}>
                      <a
                        href={item.href}
                        class={classNames(
                          item.current
                            ? 'bg-surface-1 text-accent-600 dark:bg-white/5 dark:text-white'
                            : 'text-text-secondary hover:bg-surface-1 hover:text-accent-600 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <item.icon
                          aria-hidden="true"
                          class={classNames(
                            item.current
                              ? 'text-accent-600 dark:text-white'
                              : 'text-text-muted group-hover:text-accent-600 dark:group-hover:text-white',
                            'size-6 shrink-0'
                          )}
                        />
                        {item.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li>
                <div class="text-xs/6 font-semibold text-text-muted">Your teams</div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-surface-1 text-accent-600 dark:bg-white/5 dark:text-white'
                            : 'text-text-secondary hover:bg-surface-1 hover:text-accent-600 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span
                          class={classNames(
                            team.current
                              ? 'border-accent-600 text-accent-600 dark:border-white/20 dark:text-white'
                              : 'border-surface-border text-text-muted group-hover:border-accent-600 group-hover:text-accent-600 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                            'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-white text-[0.625rem] font-medium dark:bg-white/5'
                          )}
                        >
                          {team.initial}
                        </span>
                        <span class="truncate">{team.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li class="-mx-6 mt-auto">
                <a
                  href="#"
                  class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-text-primary hover:bg-surface-1 dark:text-white dark:hover:bg-white/5"
                >
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-3 dark:outline-white/10"
                  />
                  <span class="sr-only">Your profile</span>
                  <span aria-hidden="true">Tom Cook</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-surface-0 px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-surface-2 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-0 dark:after:border-b dark:after:border-white/10 dark:after:bg-black/10">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          class="-m-2.5 p-2.5 text-text-secondary hover:text-text-primary lg:hidden dark:text-text-tertiary dark:hover:text-white"
        >
          <span class="sr-only">Open sidebar</span>
          <MenuIcon aria-hidden="true" class="size-6" />
        </button>
        <div class="flex-1 text-sm/6 font-semibold text-text-primary dark:text-white">
          Dashboard
        </div>
        <a href="#">
          <span class="sr-only">Your profile</span>
          <img
            alt=""
            src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
            class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-3 dark:outline-white/10"
          />
        </a>
      </div>

      <main class="py-10 lg:pl-72">
        <div class="px-4 sm:px-6 lg:px-8"></div>
      </main>
    </div>
  );
}

function DarkBrandSidebarWithHeader() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div>
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 lg:hidden">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-black/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
        />

        <div class="fixed inset-0 flex">
          <DialogPanel
            transition
            class="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:-translate-x-full"
          >
            <div class="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
              <button type="button" onClick={() => setSidebarOpen(false)} class="-m-2.5 p-2.5">
                <span class="sr-only">Close sidebar</span>
                <X aria-hidden="true" class="size-6 text-white" />
              </button>
            </div>

            <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-surface-2 px-6 pb-2 ring-1 ring-white/10 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
              <div class="relative flex h-16 shrink-0 items-center">
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                  class="h-8 w-auto dark:hidden"
                />
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                  class="relative h-8 w-auto hidden dark:block"
                />
              </div>
              <nav class="flex flex-1 flex-col">
                <ul role="list" class="flex flex-1 flex-col gap-y-7">
                  <li>
                    <ul role="list" class="-mx-2 space-y-1">
                      {navigation.map((item) => (
                        <li key={item.name}>
                          <a
                            href={item.href}
                            class={classNames(
                              item.current
                                ? 'bg-white/5 text-white'
                                : 'text-text-muted hover:bg-white/5 hover:text-white',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <item.icon aria-hidden="true" class="size-6 shrink-0" />
                            {item.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <div class="text-xs/6 font-semibold text-text-muted">Your teams</div>
                    <ul role="list" class="-mx-2 mt-2 space-y-1">
                      {teams.map((team) => (
                        <li key={team.name}>
                          <a
                            href={team.href}
                            class={classNames(
                              team.current
                                ? 'bg-surface-3 text-white'
                                : 'text-text-muted hover:bg-white/5 hover:text-white',
                              'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                            )}
                          >
                            <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-surface-3 text-[0.625rem] font-medium text-text-muted group-hover:border-white/20 group-hover:text-white">
                              {team.initial}
                            </span>
                            <span class="truncate">{team.name}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                </ul>
              </nav>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <div class="hidden bg-surface-2 lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
        <div class="flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border px-6 dark:border-white/10 dark:bg-black/10">
          <div class="flex h-16 shrink-0 items-center">
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
              class="h-8 w-auto dark:hidden"
            />
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
              class="h-8 w-auto hidden dark:block"
            />
          </div>
          <nav class="flex flex-1 flex-col">
            <ul role="list" class="flex flex-1 flex-col gap-y-7">
              <li>
                <ul role="list" class="-mx-2 space-y-1">
                  {navigation.map((item) => (
                    <li key={item.name}>
                      <a
                        href={item.href}
                        class={classNames(
                          item.current
                            ? 'bg-white/5 text-white'
                            : 'text-text-muted hover:bg-white/5 hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <item.icon aria-hidden="true" class="size-6 shrink-0" />
                        {item.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li>
                <div class="text-xs/6 font-semibold text-text-muted">Your teams</div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-surface-3 text-white'
                            : 'text-text-muted hover:bg-white/5 hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-surface-3 text-[0.625rem] font-medium text-text-muted group-hover:text-white">
                          {team.initial}
                        </span>
                        <span class="truncate">{team.name}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
              <li class="-mx-6 mt-auto">
                <a
                  href="#"
                  class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-white hover:bg-white/5"
                >
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-surface-3 outline -outline-offset-1 outline-white/10"
                  />
                  <span class="sr-only">Your profile</span>
                  <span aria-hidden="true">Tom Cook</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-surface-2 px-4 py-4 shadow-sm sm:px-6 lg:hidden dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-0 dark:after:border-b dark:after:border-white/10 dark:after:bg-black/10">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          class="-m-2.5 p-2.5 text-text-muted hover:text-white lg:hidden"
        >
          <span class="sr-only">Open sidebar</span>
          <MenuIcon aria-hidden="true" class="size-6" />
        </button>
        <div class="flex-1 text-sm/6 font-semibold text-white">Dashboard</div>
        <a href="#">
          <span class="sr-only">Your profile</span>
          <img
            alt=""
            src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
            class="size-8 rounded-full bg-surface-3 outline -outline-offset-1 outline-white/10"
          />
        </a>
      </div>

      <main class="py-10 lg:pl-72">
        <div class="px-4 sm:px-6 lg:px-8"></div>
      </main>
    </div>
  );
}

export function SidebarShellsDemo() {
  return (
    <div class="flex flex-col gap-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple sidebar (indigo)</h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <SimpleSidebar />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Dark sidebar with header, search, and user menu
        </h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <DarkSidebarWithHeader />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Light brand sidebar</h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <LightBrandSidebar />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Dark brand sidebar with header</h3>
        <div class="h-[32rem] rounded-lg border border-surface-border overflow-hidden dark">
          <DarkBrandSidebarWithHeader />
        </div>
      </div>
    </div>
  );
}
