import { useState } from 'preact/hooks';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  Menu,
  MenuButton,
  MenuItems,
  MenuItem,
  Popover,
  PopoverPanel,
} from '../../../../src/mod.ts';
import { classNames } from '../../../../src/internal/class-names.ts';
import {
  X,
  Home,
  Users,
  Folder,
  Calendar,
  FileText,
  PieChart,
  Bell,
  Search,
  ChevronDown,
} from 'lucide-preact';

const navigation = [
  { name: 'Dashboard', href: '#', icon: Home, current: true },
  { name: 'Team', href: '#', icon: Users, current: false },
  { name: 'Projects', href: '#', icon: Folder, current: false },
  { name: 'Calendar', href: '#', icon: Calendar, current: false },
  { name: 'Documents', href: '#', icon: FileText, current: false },
  { name: 'Reports', href: '#', icon: PieChart, current: false },
];

function Demo1() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <section>
      <h3 class="text-lg font-semibold text-text-primary mb-4">Full-width Three Column Layout</h3>
      <div class="relative">
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

              <div class="flex grow flex-col gap-y-5 overflow-y-auto bg-surface-inverted px-6 pb-2 ring-1 ring-white/10">
                <div class="flex h-16 shrink-0 items-center">
                  <img
                    alt="Your Company"
                    src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                    class="h-8 w-auto"
                  />
                </div>
                <nav class="flex flex-1 flex-col">
                  <ul role="list" class="-mx-2 flex-1 space-y-1">
                    {navigation.map((item) => (
                      <li key={item.name}>
                        <a
                          href={item.href}
                          class={classNames(
                            item.current
                              ? 'bg-white/5 text-white'
                              : 'text-gray-400 hover:bg-white/5 hover:text-white',
                            'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                          )}
                        >
                          <item.icon aria-hidden="true" class="size-6 shrink-0" />
                          {item.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
            </DialogPanel>
          </div>
        </Dialog>

        <div class="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-50 lg:block lg:w-20 lg:overflow-y-auto lg:bg-surface-inverted lg:pb-4 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-r dark:before:border-white/10 dark:before:bg-black/10">
          <div class="relative flex h-16 shrink-0 items-center justify-center">
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
              class="h-8 w-auto"
            />
          </div>
          <nav class="relative mt-8">
            <ul role="list" class="flex flex-col items-center space-y-1">
              {navigation.map((item) => (
                <li key={item.name}>
                  <a
                    href={item.href}
                    class={classNames(
                      item.current
                        ? 'bg-white/5 text-white'
                        : 'text-gray-400 hover:bg-white/5 hover:text-white',
                      'group flex gap-x-3 rounded-md p-3 text-sm/6 font-semibold'
                    )}
                  >
                    <item.icon aria-hidden="true" class="size-6 shrink-0" />
                    <span class="sr-only">{item.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-surface-inverted px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:shadow-none dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-b dark:before:border-white/10 dark:before:bg-black/10">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            class="relative -m-2.5 p-2.5 text-gray-400 lg:hidden"
          >
            <span class="sr-only">Open sidebar</span>
            <Menu aria-hidden="true" class="size-6" />
          </button>
          <div class="relative flex-1 text-sm/6 font-semibold text-white">Dashboard</div>
        </div>

        <main class="lg:pl-20">
          <div class="xl:pl-96">
            <div class="px-4 py-10 sm:px-6 lg:px-8 lg:py-6">
              <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary">
                Main Content Area
              </div>
            </div>
          </div>
        </main>

        <aside class="fixed inset-y-0 left-20 hidden w-96 overflow-y-auto border-r border-surface-border px-4 py-6 sm:px-6 lg:px-8 xl:block">
          <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary h-full">
            Secondary Column
          </div>
        </aside>
      </div>
    </section>
  );
}

const userNavigation = [
  { name: 'Your profile', href: '#' },
  { name: 'Sign out', href: '#' },
];

function Demo2() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <section>
      <h3 class="text-lg font-semibold text-text-primary mb-4">
        Full-width with Header and Right Column
      </h3>
      <div class="relative">
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

              <div class="flex grow flex-col gap-y-5 overflow-y-auto bg-surface-inverted px-6 pb-2 ring-1 ring-white/10">
                <div class="flex h-16 shrink-0 items-center">
                  <img
                    alt="Your Company"
                    src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                    class="h-8 w-auto"
                  />
                </div>
                <nav class="flex flex-1 flex-col">
                  <ul role="list" class="-mx-2 flex-1 space-y-1">
                    {navigation.map((item) => (
                      <li key={item.name}>
                        <a
                          href={item.href}
                          class={classNames(
                            item.current
                              ? 'bg-white/5 text-white'
                              : 'text-gray-400 hover:bg-white/5 hover:text-white',
                            'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                          )}
                        >
                          <item.icon aria-hidden="true" class="size-6 shrink-0" />
                          {item.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
            </DialogPanel>
          </div>
        </Dialog>

        <div class="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-50 lg:block lg:w-20 lg:overflow-y-auto lg:bg-surface-inverted lg:pb-4 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-r dark:before:border-white/10 dark:before:bg-black/10">
          <div class="relative flex h-16 shrink-0 items-center justify-center">
            <img
              alt="Your Company"
              src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
              class="h-8 w-auto"
            />
          </div>
          <nav class="relative mt-8">
            <ul role="list" class="flex flex-col items-center space-y-1">
              {navigation.map((item) => (
                <li key={item.name}>
                  <a
                    href={item.href}
                    class={classNames(
                      item.current
                        ? 'bg-white/5 text-white'
                        : 'text-gray-400 hover:bg-white/5 hover:text-white',
                      'group flex gap-x-3 rounded-md p-3 text-sm/6 font-semibold'
                    )}
                  >
                    <item.icon aria-hidden="true" class="size-6 shrink-0" />
                    <span class="sr-only">{item.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div class="lg:pl-20">
          <div class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-surface-border bg-surface-primary px-4 shadow-xs sm:gap-x-6 sm:px-6 lg:px-8 dark:shadow-none dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              class="-m-2.5 p-2.5 text-text-secondary lg:hidden"
            >
              <span class="sr-only">Open sidebar</span>
              <Menu aria-hidden="true" class="size-6" />
            </button>

            <div aria-hidden="true" class="h-6 w-px bg-surface-border lg:hidden" />

            <div class="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
              <form action="#" method="GET" class="grid flex-1 grid-cols-1">
                <input
                  name="search"
                  placeholder="Search"
                  aria-label="Search"
                  class="col-start-1 row-start-1 block size-full bg-surface-primary pl-8 text-base text-text-primary outline-hidden placeholder:text-text-tertiary sm:text-sm/6"
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 size-5 self-center text-text-tertiary"
                />
              </form>
              <div class="flex items-center gap-x-4 lg:gap-x-6">
                <button
                  type="button"
                  class="-m-2.5 p-2.5 text-text-tertiary hover:text-text-secondary"
                >
                  <span class="sr-only">View notifications</span>
                  <Bell aria-hidden="true" class="size-6" />
                </button>

                <div
                  aria-hidden="true"
                  class="hidden lg:block lg:h-6 lg:w-px lg:bg-surface-border"
                />

                <Popover class="relative">
                  <PopoverPanel
                    static
                    class="absolute right-0 z-10 mt-2.5 w-32 origin-top-right rounded-md bg-surface-primary py-2 shadow-lg outline outline-surface-border transition data-[closed]:scale-95 data-[closed]:transform data-[closed]:opacity-0"
                  >
                    {userNavigation.map((item) => (
                      <a
                        key={item.name}
                        href={item.href}
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-surface-secondary"
                      >
                        {item.name}
                      </a>
                    ))}
                  </PopoverPanel>
                </Popover>

                <Menu as="div" class="relative">
                  <MenuButton class="relative flex items-center">
                    <span class="absolute -inset-1.5" />
                    <span class="sr-only">Open user menu</span>
                    <img
                      alt=""
                      src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                      class="size-8 rounded-full bg-surface-secondary outline -outline-offset-1 outline-surface-border"
                    />
                    <span class="hidden lg:flex lg:items-center">
                      <span
                        aria-hidden="true"
                        class="ml-4 text-sm/6 font-semibold text-text-primary"
                      >
                        Tom Cook
                      </span>
                      <ChevronDown aria-hidden="true" class="ml-2 size-5 text-text-tertiary" />
                    </span>
                  </MenuButton>
                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2.5 w-32 origin-top-right rounded-md bg-surface-primary py-2 shadow-lg outline outline-surface-border transition data-[closed]:scale-95 data-[closed]:transform data-[closed]:opacity-0"
                  >
                    {userNavigation.map((item) => (
                      <MenuItem key={item.name}>
                        <a
                          href={item.href}
                          class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-surface-secondary data-[focus]:outline-hidden"
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

          <main class="xl:pl-96">
            <div class="px-4 py-10 sm:px-6 lg:px-8 lg:py-6">
              <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary">
                Main Content Area
              </div>
            </div>
          </main>
        </div>

        <aside class="fixed top-16 bottom-0 left-20 hidden w-96 overflow-y-auto border-r border-surface-border px-4 py-6 sm:px-6 lg:px-8 xl:block">
          <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary h-full">
            Secondary Column
          </div>
        </aside>
      </div>
    </section>
  );
}

const teams = [
  { id: 1, name: 'Heroicons', href: '#', initial: 'H', current: false },
  { id: 2, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  { id: 3, name: 'Workcation', href: '#', initial: 'W', current: false },
];

function Demo3() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <section>
      <h3 class="text-lg font-semibold text-text-primary mb-4">Full-width with Narrow Sidebar</h3>
      <div class="relative">
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

              <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-surface-primary px-6 pb-2 dark:bg-surface-inverted dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-r dark:before:border-white/10 dark:before:bg-black/10">
                <div class="relative flex h-16 shrink-0 items-center">
                  <img
                    alt="Your Company"
                    src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                    class="h-8 w-auto"
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
                                  ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                                  : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                              )}
                            >
                              <item.icon
                                aria-hidden="true"
                                class={classNames(
                                  item.current
                                    ? 'text-accent-primary dark:text-white'
                                    : 'text-text-tertiary group-hover:text-accent-primary dark:text-text-tertiary dark:group-hover:text-white',
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
                      <div class="text-xs/6 font-semibold text-text-tertiary">Your teams</div>
                      <ul role="list" class="-mx-2 mt-2 space-y-1">
                        {teams.map((team) => (
                          <li key={team.name}>
                            <a
                              href={team.href}
                              class={classNames(
                                team.current
                                  ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                                  : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                              )}
                            >
                              <span
                                class={classNames(
                                  team.current
                                    ? 'border-accent-primary text-accent-primary dark:border-white/20 dark:text-white'
                                    : 'border-surface-border text-text-tertiary group-hover:border-accent-primary group-hover:text-accent-primary dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                                  'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-surface-primary text-[0.625rem] font-medium dark:bg-white/5'
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

        <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
          <div class="relative flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-primary px-6 dark:border-white/10 dark:bg-surface-inverted dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
            <div class="relative flex h-16 shrink-0 items-center">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                class="h-8 w-auto"
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
                              ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                              : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                            'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                          )}
                        >
                          <item.icon
                            aria-hidden="true"
                            class={classNames(
                              item.current
                                ? 'text-accent-primary dark:text-white'
                                : 'text-text-tertiary group-hover:text-accent-primary dark:text-text-tertiary dark:group-hover:text-white',
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
                  <div class="text-xs/6 font-semibold text-text-tertiary">Your teams</div>
                  <ul role="list" class="-mx-2 mt-2 space-y-1">
                    {teams.map((team) => (
                      <li key={team.name}>
                        <a
                          href={team.href}
                          class={classNames(
                            team.current
                              ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                              : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                            'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                          )}
                        >
                          <span
                            class={classNames(
                              team.current
                                ? 'border-accent-primary text-accent-primary dark:border-white/20 dark:text-white'
                                : 'border-surface-border text-text-tertiary group-hover:border-accent-primary group-hover:text-accent-primary dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                              'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-surface-primary text-[0.625rem] font-medium dark:bg-white/5'
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
                    class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-text-primary hover:bg-surface-secondary dark:text-white dark:hover:bg-white/5"
                  >
                    <img
                      alt=""
                      src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                      class="size-8 rounded-full bg-surface-secondary outline -outline-offset-1 outline-surface-border dark:bg-surface-inverted dark:outline-white/10"
                    />
                    <span class="sr-only">Your profile</span>
                    <span aria-hidden="true">Tom Cook</span>
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </div>

        <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-surface-primary px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-surface-inverted dark:shadow-none dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-b dark:before:border-white/10 dark:before:bg-black/10">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            class="relative -m-2.5 p-2.5 text-text-secondary lg:hidden"
          >
            <span class="sr-only">Open sidebar</span>
            <Menu aria-hidden="true" class="size-6" />
          </button>
          <div class="relative flex-1 text-sm/6 font-semibold text-text-primary">Dashboard</div>
          <a href="#" class="relative">
            <span class="sr-only">Your profile</span>
            <img
              alt=""
              src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
              class="size-8 rounded-full bg-surface-secondary outline -outline-offset-1 outline-surface-border dark:bg-surface-inverted dark:outline-white/10"
            />
          </a>
        </div>

        <main class="lg:pl-72">
          <div class="xl:pl-96">
            <div class="px-4 py-10 sm:px-6 lg:px-8 lg:py-6">
              <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary">
                Main Content Area
              </div>
            </div>
          </div>
        </main>

        <aside class="fixed inset-y-0 left-72 hidden w-96 overflow-y-auto border-r border-surface-border px-4 py-6 sm:px-6 lg:px-8 xl:block">
          <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary h-full">
            Secondary Column
          </div>
        </aside>
      </div>
    </section>
  );
}

function Demo4() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <section>
      <h3 class="text-lg font-semibold text-text-primary mb-4">
        Full-width with Narrow Sidebar and Header
      </h3>
      <div class="relative">
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

              <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-surface-primary px-6 pb-2 dark:bg-surface-inverted dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-r dark:before:border-white/10 dark:before:bg-black/10">
                <div class="relative flex h-16 shrink-0 items-center">
                  <img
                    alt="Your Company"
                    src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                    class="h-8 w-auto"
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
                                  ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                                  : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                              )}
                            >
                              <item.icon
                                aria-hidden="true"
                                class={classNames(
                                  item.current
                                    ? 'text-accent-primary dark:text-white'
                                    : 'text-text-tertiary group-hover:text-accent-primary dark:text-text-tertiary dark:group-hover:text-white',
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
                      <div class="text-xs/6 font-semibold text-text-tertiary">Your teams</div>
                      <ul role="list" class="-mx-2 mt-2 space-y-1">
                        {teams.map((team) => (
                          <li key={team.name}>
                            <a
                              href={team.href}
                              class={classNames(
                                team.current
                                  ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                                  : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                              )}
                            >
                              <span
                                class={classNames(
                                  team.current
                                    ? 'border-accent-primary text-accent-primary dark:border-white/20 dark:text-white'
                                    : 'border-surface-border text-text-tertiary group-hover:border-accent-primary group-hover:text-accent-primary dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                                  'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-surface-primary text-[0.625rem] font-medium dark:bg-white/5'
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

        <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
          <div class="relative flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-primary px-6 dark:border-white/10 dark:bg-surface-inverted dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
            <div class="relative flex h-16 shrink-0 items-center">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                class="h-8 w-auto"
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
                              ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                              : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                            'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                          )}
                        >
                          <item.icon
                            aria-hidden="true"
                            class={classNames(
                              item.current
                                ? 'text-accent-primary dark:text-white'
                                : 'text-text-tertiary group-hover:text-accent-primary dark:text-text-tertiary dark:group-hover:text-white',
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
                  <div class="text-xs/6 font-semibold text-text-tertiary">Your teams</div>
                  <ul role="list" class="-mx-2 mt-2 space-y-1">
                    {teams.map((team) => (
                      <li key={team.name}>
                        <a
                          href={team.href}
                          class={classNames(
                            team.current
                              ? 'bg-surface-secondary text-accent-primary dark:bg-white/5 dark:text-white'
                              : 'text-text-secondary hover:bg-surface-secondary hover:text-accent-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                            'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                          )}
                        >
                          <span
                            class={classNames(
                              team.current
                                ? 'border-accent-primary text-accent-primary dark:border-white/20 dark:text-white'
                                : 'border-surface-border text-text-tertiary group-hover:border-accent-primary group-hover:text-accent-primary dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                              'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-surface-primary text-[0.625rem] font-medium dark:bg-white/5'
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
                    class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-text-primary hover:bg-surface-secondary dark:text-white dark:hover:bg-white/5"
                  >
                    <img
                      alt=""
                      src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                      class="size-8 rounded-full bg-surface-secondary outline -outline-offset-1 outline-surface-border dark:bg-surface-inverted dark:outline-white/10"
                    />
                    <span class="sr-only">Your profile</span>
                    <span aria-hidden="true">Tom Cook</span>
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </div>

        <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-surface-primary px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-surface-inverted dark:shadow-none dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-b dark:before:border-white/10 dark:before:bg-black/10">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            class="relative -m-2.5 p-2.5 text-text-secondary lg:hidden"
          >
            <span class="sr-only">Open sidebar</span>
            <Menu aria-hidden="true" class="size-6" />
          </button>
          <div class="relative flex-1 text-sm/6 font-semibold text-text-primary">Dashboard</div>
          <a href="#" class="relative">
            <span class="sr-only">Your profile</span>
            <img
              alt=""
              src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
              class="size-8 rounded-full bg-surface-secondary outline -outline-offset-1 outline-surface-border dark:bg-surface-inverted dark:outline-white/10"
            />
          </a>
        </div>

        <main class="lg:pl-72">
          <div class="xl:pr-96">
            <div class="px-4 py-10 sm:px-6 lg:px-8 lg:py-6">
              <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary">
                Main Content Area
              </div>
            </div>
          </div>
        </main>

        <aside class="fixed inset-y-0 right-0 hidden w-96 overflow-y-auto border-l border-surface-border px-4 py-6 sm:px-6 lg:px-8 xl:block">
          <div class="bg-surface-primary rounded-lg border border-surface-border p-8 text-center text-text-secondary h-full">
            Secondary Column (Right)
          </div>
        </aside>
      </div>
    </section>
  );
}

export function MultiColumnShellsDemo() {
  return (
    <div class="space-y-12">
      <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
        <Demo1 />
      </div>
      <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
        <Demo2 />
      </div>
      <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
        <Demo3 />
      </div>
      <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
        <Demo4 />
      </div>
    </div>
  );
}
