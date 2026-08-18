import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Popover,
  PopoverButton,
  PopoverPanel,
} from '../../../src/mod.ts';
import { classNames } from '../../../src/internal/class-names.ts';
import { Bell, Menu as MenuIcon, Plus, Search, X } from 'lucide-preact';

const user = {
  name: 'Tom Cook',
  email: 'tom@example.com',
  imageUrl:
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
};

const userImageAlt =
  'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80';

const navigation = [
  { name: 'Dashboard', href: '#', current: true },
  { name: 'Team', href: '#', current: false },
  { name: 'Projects', href: '#', current: false },
  { name: 'Calendar', href: '#', current: false },
];

const userNavigation = [
  { name: 'Your profile', href: '#' },
  { name: 'Settings', href: '#' },
  { name: 'Sign out', href: '#' },
];

function SimpleDarkWithMenuButtonOnLeft() {
  return (
    <Disclosure
      as="nav"
      class="relative bg-surface-2 dark:bg-surface-2/50 dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-16 items-center justify-between">
          <div class="flex items-center">
            <div class="shrink-0">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                class="h-8 w-auto"
              />
            </div>
            <div class="hidden sm:ml-6 sm:block">
              <div class="flex space-x-4">
                {navigation.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    aria-current={item.current ? 'page' : undefined}
                    class={classNames(
                      item.current
                        ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                        : 'text-gray-300 hover:bg-white/5 hover:text-white',
                      'rounded-md px-3 py-2 text-sm font-medium'
                    )}
                  >
                    {item.name}
                  </a>
                ))}
              </div>
            </div>
          </div>
          <div class="hidden sm:ml-6 sm:block">
            <div class="flex items-center">
              <button
                type="button"
                class="relative rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-3">
                <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={userImageAlt}
                    class="size-8 rounded-full bg-surface-2 outline outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
                >
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      Your profile
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      Settings
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      Sign out
                    </a>
                  </MenuItem>
                </MenuItems>
              </Menu>
            </div>
          </div>
          <div class="-mr-2 flex sm:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-white focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open main menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
        </div>
      </div>

      <DisclosurePanel class="sm:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3">
          {navigation.map((item) => (
            <DisclosureButton
              key={item.name}
              as="a"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                  : 'text-gray-300 hover:bg-white/5 hover:text-white',
                'block rounded-md px-3 py-2 text-base font-medium'
              )}
            >
              {item.name}
            </DisclosureButton>
          ))}
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function DarkWithQuickAction() {
  return (
    <Disclosure
      as="nav"
      class="relative bg-surface-2 dark:bg-surface-2/50 dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-16 justify-between">
          <div class="flex">
            <div class="mr-2 -ml-2 flex items-center md:hidden">
              <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-white focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500">
                <span class="absolute -inset-0.5" />
                <span class="sr-only">Open main menu</span>
                <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
                <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
              </DisclosureButton>
            </div>
            <div class="flex shrink-0 items-center">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                class="h-8 w-auto"
              />
            </div>
            <div class="hidden md:ml-6 md:flex md:items-center md:space-x-4">
              {navigation.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  aria-current={item.current ? 'page' : undefined}
                  class={classNames(
                    item.current
                      ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                      : 'text-gray-300 hover:bg-white/5 hover:text-white',
                    'rounded-md px-3 py-2 text-sm font-medium'
                  )}
                >
                  {item.name}
                </a>
              ))}
            </div>
          </div>
          <div class="flex items-center">
            <div class="shrink-0">
              <button
                type="button"
                class="relative inline-flex items-center gap-x-1.5 rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:shadow-none"
              >
                <Plus aria-hidden="true" class="-ml-0.5 size-5" />
                New Job
              </button>
            </div>
            <div class="hidden md:ml-4 md:flex md:shrink-0 md:items-center">
              <button
                type="button"
                class="relative rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-3">
                <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={userImageAlt}
                    class="size-8 rounded-full bg-surface-2 outline outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-200 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
                >
                  {userNavigation.map((item) => (
                    <MenuItem key={item.name}>
                      <a
                        href={item.href}
                        class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-200 dark:data-focus:bg-white/5"
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
      </div>

      <DisclosurePanel class="md:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3 sm:px-3">
          {navigation.map((item) => (
            <DisclosureButton
              key={item.name}
              as="a"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                  : 'text-gray-300 hover:bg-white/5 hover:text-white',
                'block rounded-md px-3 py-2 text-base font-medium'
              )}
            >
              {item.name}
            </DisclosureButton>
          ))}
        </div>
        <div class="border-t border-white/10 pt-4 pb-3">
          <div class="flex items-center px-5 sm:px-6">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-2 outline outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-white">{user.name}</div>
              <div class="text-sm font-medium text-gray-400">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1 px-2 sm:px-3">
            {userNavigation.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                class="block rounded-md px-3 py-2 text-base font-medium text-gray-400 hover:bg-white/5 hover:text-white"
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function SimpleDark() {
  return (
    <Disclosure
      as="nav"
      class="relative bg-surface-2 dark:bg-surface-2/50 dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-16 items-center justify-between">
          <div class="flex items-center px-2 lg:px-0">
            <div class="shrink-0">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                class="h-8 w-auto"
              />
            </div>
            <div class="hidden lg:ml-6 lg:block">
              <div class="flex space-x-4">
                <a
                  href="#"
                  class="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white dark:bg-gray-950/50"
                >
                  Dashboard
                </a>
                <a
                  href="#"
                  class="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white"
                >
                  Team
                </a>
                <a
                  href="#"
                  class="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white"
                >
                  Projects
                </a>
                <a
                  href="#"
                  class="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white"
                >
                  Calendar
                </a>
              </div>
            </div>
          </div>
          <div class="flex flex-1 justify-center px-2 lg:ml-6 lg:justify-end">
            <div class="grid w-full max-w-lg grid-cols-1 lg:max-w-xs">
              <input
                name="search"
                placeholder="Search"
                aria-label="Search"
                class="col-start-1 row-start-1 block w-full rounded-md bg-white/5 py-1.5 pr-3 pl-10 text-base text-white outline outline-white/10 placeholder:text-gray-500 focus:text-white focus:outline-2 focus:outline-accent-500 sm:text-sm/6"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400"
              />
            </div>
          </div>
          <div class="flex lg:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-white focus:outline-2 focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open main menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
          <div class="hidden lg:ml-4 lg:block">
            <div class="flex items-center">
              <button
                type="button"
                class="relative shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-4 shrink-0">
                <MenuButton class="relative flex rounded-full text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={userImageAlt}
                    class="size-8 rounded-full bg-surface-2 outline outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
                >
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-gray-700"
                    >
                      Your profile
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-gray-700"
                    >
                      Settings
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-gray-700"
                    >
                      Sign out
                    </a>
                  </MenuItem>
                </MenuItems>
              </Menu>
            </div>
          </div>
        </div>
      </div>

      <DisclosurePanel class="lg:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3">
          <a
            href="#"
            class="block rounded-md bg-gray-900 px-3 py-2 text-base font-medium text-white dark:bg-gray-950/50"
          >
            Dashboard
          </a>
          <a
            href="#"
            class="block rounded-md px-3 py-2 text-base font-medium text-gray-300 hover:bg-white/5 hover:text-white"
          >
            Team
          </a>
          <a
            href="#"
            class="block rounded-md px-3 py-2 text-base font-medium text-gray-300 hover:bg-white/5 hover:text-white"
          >
            Projects
          </a>
          <a
            href="#"
            class="block rounded-md px-3 py-2 text-base font-medium text-gray-300 hover:bg-white/5 hover:text-white"
          >
            Calendar
          </a>
        </div>
        <div class="border-t border-white/10 pt-4 pb-3">
          <div class="flex items-center px-5">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-2 outline outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-white">{user.name}</div>
              <div class="text-sm font-medium text-gray-400">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1 px-2">
            <a
              href="#"
              class="block rounded-md px-3 py-2 text-base font-medium text-gray-400 hover:bg-white/5 hover:text-white"
            >
              Your profile
            </a>
            <a
              href="#"
              class="block rounded-md px-3 py-2 text-base font-medium text-gray-400 hover:bg-white/5 hover:text-white"
            >
              Settings
            </a>
            <a
              href="#"
              class="block rounded-md px-3 py-2 text-base font-medium text-gray-400 hover:bg-white/5 hover:text-white"
            >
              Sign out
            </a>
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function SimpleWithMenuButtonOnLeft() {
  return (
    <Disclosure
      as="nav"
      class="relative bg-surface-0 shadow-sm dark:bg-surface-2/50 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-16 items-center justify-between">
          <div class="flex">
            <div class="flex shrink-0 items-center">
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
            <div class="hidden sm:ml-6 sm:block">
              <div class="flex space-x-8">
                <a
                  href="#"
                  class="inline-flex items-center border-b-2 border-accent-500 px-1 pt-1 text-sm font-medium text-text-primary dark:text-white"
                >
                  Dashboard
                </a>
                <a
                  href="#"
                  class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:text-white"
                >
                  Team
                </a>
                <a
                  href="#"
                  class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:text-white"
                >
                  Projects
                </a>
                <a
                  href="#"
                  class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:text-white"
                >
                  Calendar
                </a>
              </div>
            </div>
          </div>
          <div class="hidden sm:ml-6 sm:flex sm:items-center">
            <button
              type="button"
              class="relative rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>

            <Menu as="div" class="relative ml-3">
              <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                <span class="absolute -inset-1.5" />
                <span class="sr-only">Open user menu</span>
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-8 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-200 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
              >
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                  >
                    Your profile
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                  >
                    Settings
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                  >
                    Sign out
                  </a>
                </MenuItem>
              </MenuItems>
            </Menu>
          </div>
          <div class="-mr-2 flex items-center sm:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-text-tertiary hover:bg-surface-1 hover:text-text-secondary focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500 dark:hover:bg-white/5 dark:hover:text-white dark:focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open main menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
        </div>
      </div>

      <DisclosurePanel class="sm:hidden">
        <div class="space-y-1 pt-2 pb-3">
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-accent-500 bg-accent-500/10 py-2 pr-4 pl-3 text-base font-medium text-accent-700 dark:border-accent-500 dark:bg-accent-500/10 dark:text-accent-400"
          >
            Dashboard
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Team
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Projects
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Calendar
          </DisclosureButton>
        </div>
        <div class="border-t border-surface-border pt-4 pb-3 dark:border-white/10">
          <div class="flex items-center px-4">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-text-primary dark:text-gray-200">
                {user.name}
              </div>
              <div class="text-sm font-medium text-text-tertiary">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1">
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Your profile
            </DisclosureButton>
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Settings
            </DisclosureButton>
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Sign out
            </DisclosureButton>
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function SimpleNavbar() {
  return (
    <Disclosure
      as="nav"
      class="relative bg-surface-0 shadow-sm dark:bg-surface-2/50 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-2 sm:px-4 lg:px-8">
        <div class="flex h-16 justify-between">
          <div class="flex px-2 lg:px-0">
            <div class="flex shrink-0 items-center">
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
            <div class="hidden lg:ml-6 lg:flex lg:space-x-8">
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-accent-500 px-1 pt-1 text-sm font-medium text-text-primary dark:border-accent-500 dark:text-white"
              >
                Dashboard
              </a>
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
              >
                Team
              </a>
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
              >
                Projects
              </a>
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
              >
                Calendar
              </a>
            </div>
          </div>
          <div class="flex flex-1 items-center justify-center px-2 lg:ml-6 lg:justify-end">
            <div class="grid w-full max-w-lg grid-cols-1 lg:max-w-xs">
              <input
                name="search"
                type="search"
                placeholder="Search"
                class="col-start-1 row-start-1 block w-full rounded-md bg-surface-0 py-1.5 pr-3 pl-10 text-base text-text-primary outline outline-surface-border placeholder:text-text-tertiary focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-accent-500"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-text-tertiary"
              />
            </div>
          </div>
          <div class="flex items-center lg:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-text-tertiary hover:bg-surface-1 hover:text-text-secondary focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500 dark:hover:bg-white/5 dark:hover:text-white dark:focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open main menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
          <div class="hidden lg:ml-4 lg:flex lg:items-center">
            <button
              type="button"
              class="relative shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>

            <Menu as="div" class="relative ml-4 shrink-0">
              <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                <span class="absolute -inset-1.5" />
                <span class="sr-only">Open user menu</span>
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-8 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
              >
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                  >
                    Your profile
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                  >
                    Settings
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                  >
                    Sign out
                  </a>
                </MenuItem>
              </MenuItems>
            </Menu>
          </div>
        </div>
      </div>

      <DisclosurePanel class="lg:hidden">
        <div class="space-y-1 pt-2 pb-3">
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-accent-500 bg-accent-500/10 py-2 pr-4 pl-3 text-base font-medium text-accent-700 dark:border-accent-500 dark:bg-accent-500/10 dark:text-accent-400"
          >
            Dashboard
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Team
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Projects
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Calendar
          </DisclosureButton>
        </div>
        <div class="border-t border-surface-border pt-4 pb-3 dark:border-white/10">
          <div class="flex items-center px-4">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-text-primary dark:text-gray-200">
                {user.name}
              </div>
              <div class="text-sm font-medium text-text-tertiary">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1">
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Your profile
            </DisclosureButton>
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Settings
            </DisclosureButton>
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Sign out
            </DisclosureButton>
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function WithQuickAction() {
  return (
    <Disclosure
      as="nav"
      class="relative bg-surface-0 shadow-sm dark:bg-surface-2/50 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="flex h-16 justify-between">
          <div class="flex">
            <div class="mr-2 -ml-2 flex items-center md:hidden">
              <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-text-tertiary hover:bg-surface-1 hover:text-text-secondary focus:ring-2 focus:ring-accent-500 focus:outline-hidden focus:ring-inset dark:hover:bg-white/5 dark:hover:text-white dark:focus:ring-white">
                <span class="absolute -inset-0.5" />
                <span class="sr-only">Open main menu</span>
                <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
                <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
              </DisclosureButton>
            </div>
            <div class="flex shrink-0 items-center">
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
            <div class="hidden md:ml-6 md:flex md:space-x-8">
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-accent-500 px-1 pt-1 text-sm font-medium text-text-primary dark:border-accent-500 dark:text-white"
              >
                Dashboard
              </a>
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:text-white"
              >
                Team
              </a>
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:text-white"
              >
                Projects
              </a>
              <a
                href="#"
                class="inline-flex items-center border-b-2 border-transparent px-1 pt-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-300 dark:hover:border-white/20 dark:hover:text-white"
              >
                Calendar
              </a>
            </div>
          </div>
          <div class="flex items-center">
            <div class="shrink-0">
              <button
                type="button"
                class="relative inline-flex items-center gap-x-1.5 rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-500"
              >
                <Plus aria-hidden="true" class="-ml-0.5 size-5" />
                New Job
              </button>
            </div>
            <div class="hidden md:ml-4 md:flex md:shrink-0 md:items-center">
              <button
                type="button"
                class="relative rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white dark:focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-3">
                <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={userImageAlt}
                    class="size-8 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-200 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
                >
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      Your profile
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      Settings
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      Sign out
                    </a>
                  </MenuItem>
                </MenuItems>
              </Menu>
            </div>
          </div>
        </div>
      </div>

      <DisclosurePanel class="md:hidden">
        <div class="space-y-1 pt-2 pb-3">
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-accent-500 bg-accent-500/10 py-2 pr-4 pl-3 text-base font-medium text-accent-700 sm:pr-6 sm:pl-5 dark:border-accent-500 dark:bg-accent-500/10 dark:text-accent-400"
          >
            Dashboard
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary sm:pr-6 sm:pl-5 dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Team
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary sm:pr-6 sm:pl-5 dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Projects
          </DisclosureButton>
          <DisclosureButton
            as="a"
            href="#"
            class="block border-l-4 border-transparent py-2 pr-4 pl-3 text-base font-medium text-text-secondary hover:border-surface-border hover:bg-surface-1 hover:text-text-primary sm:pr-6 sm:pl-5 dark:text-gray-300 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-white"
          >
            Calendar
          </DisclosureButton>
        </div>
        <div class="border-t border-surface-border pt-4 pb-3 dark:border-white/10">
          <div class="flex items-center px-4 sm:px-6">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-text-primary dark:text-white">{user.name}</div>
              <div class="text-sm font-medium text-text-tertiary">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1">
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Your profile
            </DisclosureButton>
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Settings
            </DisclosureButton>
            <DisclosureButton
              as="a"
              href="#"
              class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Sign out
            </DisclosureButton>
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function DarkWithSearch() {
  return (
    <Disclosure
      as="header"
      class="relative bg-surface-2 dark:bg-surface-2/50 dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-2 sm:px-4 lg:divide-y lg:divide-white/10 lg:px-8">
        <div class="relative flex h-16 justify-between">
          <div class="relative z-10 flex px-2 lg:px-0">
            <div class="flex shrink-0 items-center">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                class="h-8 w-auto"
              />
            </div>
          </div>
          <div class="relative z-0 flex flex-1 items-center justify-center px-2 sm:absolute sm:inset-0">
            <div class="grid w-full grid-cols-1 sm:max-w-xs">
              <input
                name="search"
                placeholder="Search"
                aria-label="Search"
                class="col-start-1 row-start-1 block w-full rounded-md border-0 bg-white/5 py-1.5 pr-3 pl-10 text-white outline outline-white/10 placeholder:text-gray-500 focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400"
              />
            </div>
          </div>
          <div class="relative z-10 flex items-center lg:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-gray-300 focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
          <div class="hidden lg:relative lg:z-10 lg:ml-4 lg:flex lg:items-center">
            <button
              type="button"
              class="relative shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>

            <Menu as="div" class="relative ml-4 shrink-0">
              <MenuButton class="relative flex rounded-full focus-visible:ring-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                <span class="absolute -inset-1.5" />
                <span class="sr-only">Open user menu</span>
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-8 rounded-full bg-surface-2 outline outline-white/10"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
              >
                {userNavigation.map((item) => (
                  <MenuItem key={item.name}>
                    <a
                      href={item.href}
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-200 dark:data-focus:bg-white/5"
                    >
                      {item.name}
                    </a>
                  </MenuItem>
                ))}
              </MenuItems>
            </Menu>
          </div>
        </div>
        <nav aria-label="Global" class="hidden lg:flex lg:space-x-8 lg:py-2">
          {navigation.map((item) => (
            <a
              key={item.name}
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                  : 'text-gray-300 hover:bg-white/5 hover:text-white',
                'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {item.name}
            </a>
          ))}
        </nav>
      </div>

      <DisclosurePanel as="nav" aria-label="Global" class="lg:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3">
          {navigation.map((item) => (
            <DisclosureButton
              key={item.name}
              as="a"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                  : 'text-gray-300 hover:bg-white/5 hover:text-white',
                'block rounded-md px-3 py-2 text-base font-medium'
              )}
            >
              {item.name}
            </DisclosureButton>
          ))}
        </div>
        <div class="border-t border-white/10 pt-4 pb-3">
          <div class="flex items-center px-4">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-2 outline outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-white">{user.name}</div>
              <div class="text-sm font-medium text-gray-400">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1 px-2">
            {userNavigation.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                class="block rounded-md px-3 py-2 text-base font-medium text-gray-400 hover:bg-white/5 hover:text-white"
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function WithSearch() {
  return (
    <Disclosure
      as="header"
      class="relative bg-surface-0 shadow-sm dark:bg-surface-2/50 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-2 sm:px-4 lg:divide-y lg:divide-surface-border lg:px-8 dark:lg:divide-white/10">
        <div class="relative flex h-16 justify-between">
          <div class="relative z-10 flex px-2 lg:px-0">
            <div class="flex shrink-0 items-center">
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
          </div>
          <div class="relative z-0 flex flex-1 items-center justify-center px-2 sm:absolute sm:inset-0">
            <div class="grid w-full grid-cols-1 sm:max-w-xs">
              <input
                name="search"
                placeholder="Search"
                class="col-start-1 row-start-1 block w-full rounded-md bg-surface-0 py-1.5 pr-3 pl-10 text-base text-text-primary outline outline-surface-border placeholder:text-text-tertiary focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-accent-500"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-text-tertiary"
              />
            </div>
          </div>
          <div class="relative z-10 flex items-center lg:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-text-tertiary hover:bg-surface-1 hover:text-text-secondary focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white dark:focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
          <div class="hidden lg:relative lg:z-10 lg:ml-4 lg:flex lg:items-center">
            <button
              type="button"
              class="relative shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>

            <Menu as="div" class="relative ml-4 shrink-0">
              <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                <span class="absolute -inset-1.5" />
                <span class="sr-only">Open user menu</span>
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-8 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
              >
                {userNavigation.map((item) => (
                  <MenuItem key={item.name}>
                    <a
                      href={item.href}
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      {item.name}
                    </a>
                  </MenuItem>
                ))}
              </MenuItems>
            </Menu>
          </div>
        </div>
        <nav aria-label="Global" class="hidden lg:flex lg:space-x-8 lg:py-2">
          {navigation.map((item) => (
            <a
              key={item.name}
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-surface-1 text-text-primary dark:bg-gray-950/50 dark:text-white'
                  : 'text-text-primary hover:bg-surface-1 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white',
                'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {item.name}
            </a>
          ))}
        </nav>
      </div>

      <DisclosurePanel as="nav" aria-label="Global" class="lg:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3">
          {navigation.map((item) => (
            <DisclosureButton
              key={item.name}
              as="a"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-surface-1 text-text-primary dark:bg-white/5 dark:text-white'
                  : 'text-text-primary hover:bg-surface-1 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white',
                'block rounded-md px-3 py-2 text-base font-medium'
              )}
            >
              {item.name}
            </DisclosureButton>
          ))}
        </div>
        <div class="border-t border-surface-border pt-4 pb-3 dark:border-white/10">
          <div class="flex items-center px-4">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-text-primary dark:text-white">{user.name}</div>
              <div class="text-sm font-medium text-text-tertiary">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1 px-2">
            {userNavigation.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                class="block rounded-md px-3 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function DarkWithCenteredSearchAndSecondaryLinks() {
  return (
    <Disclosure
      as="header"
      class="relative bg-surface-2 dark:bg-surface-2/50 dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-2 sm:px-4 lg:divide-y lg:divide-white/10 lg:px-8">
        <div class="relative flex h-16 justify-between">
          <div class="relative z-10 flex px-2 lg:px-0">
            <div class="flex shrink-0 items-center">
              <img
                alt="Your Company"
                src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                class="h-8 w-auto"
              />
            </div>
          </div>
          <div class="relative z-0 flex flex-1 items-center justify-center px-2 sm:absolute sm:inset-0">
            <div class="grid w-full grid-cols-1 sm:max-w-xs">
              <input
                name="search"
                placeholder="Search"
                aria-label="Search"
                class="col-start-1 row-start-1 block w-full rounded-md border-0 bg-white/5 py-1.5 pr-3 pl-10 text-white outline outline-white/10 placeholder:text-gray-500 focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400"
              />
            </div>
          </div>
          <div class="relative z-10 flex items-center lg:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-gray-300 focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
          <div class="hidden lg:relative lg:z-10 lg:ml-4 lg:flex lg:items-center">
            <button
              type="button"
              class="relative shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>

            <Menu as="div" class="relative ml-4 shrink-0">
              <MenuButton class="relative flex rounded-full focus-visible:ring-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                <span class="absolute -inset-1.5" />
                <span class="sr-only">Open user menu</span>
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-8 rounded-full bg-surface-2 outline outline-white/10"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
              >
                {userNavigation.map((item) => (
                  <MenuItem key={item.name}>
                    <a
                      href={item.href}
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-200 dark:data-focus:bg-white/5"
                    >
                      {item.name}
                    </a>
                  </MenuItem>
                ))}
              </MenuItems>
            </Menu>
          </div>
        </div>
        <nav aria-label="Global" class="hidden lg:flex lg:space-x-8 lg:py-2">
          {navigation.map((item) => (
            <a
              key={item.name}
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                  : 'text-gray-300 hover:bg-white/5 hover:text-white',
                'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {item.name}
            </a>
          ))}
        </nav>
      </div>

      <DisclosurePanel as="nav" aria-label="Global" class="lg:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3">
          {navigation.map((item) => (
            <DisclosureButton
              key={item.name}
              as="a"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-gray-900 text-white dark:bg-gray-950/50'
                  : 'text-gray-300 hover:bg-white/5 hover:text-white',
                'block rounded-md px-3 py-2 text-base font-medium'
              )}
            >
              {item.name}
            </DisclosureButton>
          ))}
        </div>
        <div class="border-t border-white/10 pt-4 pb-3">
          <div class="flex items-center px-4">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-2 outline outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-white">{user.name}</div>
              <div class="text-sm font-medium text-gray-400">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1 px-2">
            {userNavigation.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                class="block rounded-md px-3 py-2 text-base font-medium text-gray-400 hover:bg-white/5 hover:text-white"
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function WithCenteredSearchAndSecondaryLinks() {
  return (
    <Disclosure
      as="header"
      class="relative bg-surface-0 shadow-sm dark:bg-surface-2/50 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10"
    >
      <div class="mx-auto max-w-7xl px-2 sm:px-4 lg:divide-y lg:divide-surface-border lg:px-8 dark:lg:divide-white/10">
        <div class="relative flex h-16 justify-between">
          <div class="relative z-10 flex px-2 lg:px-0">
            <div class="flex shrink-0 items-center">
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
          </div>
          <div class="relative z-0 flex flex-1 items-center justify-center px-2 sm:absolute sm:inset-0">
            <div class="grid w-full grid-cols-1 sm:max-w-xs">
              <input
                name="search"
                placeholder="Search"
                class="col-start-1 row-start-1 block w-full rounded-md bg-surface-0 py-1.5 pr-3 pl-10 text-base text-text-primary outline outline-surface-border placeholder:text-text-tertiary focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-accent-500"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-text-tertiary"
              />
            </div>
          </div>
          <div class="relative z-10 flex items-center lg:hidden">
            <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-text-tertiary hover:bg-surface-1 hover:text-text-secondary focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white dark:focus:outline-accent-500">
              <span class="absolute -inset-0.5" />
              <span class="sr-only">Open menu</span>
              <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
              <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
            </DisclosureButton>
          </div>
          <div class="hidden lg:relative lg:z-10 lg:ml-4 lg:flex lg:items-center">
            <button
              type="button"
              class="relative shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>

            <Menu as="div" class="relative ml-4 shrink-0">
              <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                <span class="absolute -inset-1.5" />
                <span class="sr-only">Open user menu</span>
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-8 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
              >
                {userNavigation.map((item) => (
                  <MenuItem key={item.name}>
                    <a
                      href={item.href}
                      class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                    >
                      {item.name}
                    </a>
                  </MenuItem>
                ))}
              </MenuItems>
            </Menu>
          </div>
        </div>
        <nav aria-label="Global" class="hidden lg:flex lg:space-x-8 lg:py-2">
          {navigation.map((item) => (
            <a
              key={item.name}
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-surface-1 text-text-primary dark:bg-gray-950/50 dark:text-white'
                  : 'text-text-primary hover:bg-surface-1 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white',
                'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {item.name}
            </a>
          ))}
        </nav>
      </div>

      <DisclosurePanel as="nav" aria-label="Global" class="lg:hidden">
        <div class="space-y-1 px-2 pt-2 pb-3">
          {navigation.map((item) => (
            <DisclosureButton
              key={item.name}
              as="a"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              class={classNames(
                item.current
                  ? 'bg-surface-1 text-text-primary dark:bg-white/5 dark:text-white'
                  : 'text-text-primary hover:bg-surface-1 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white',
                'block rounded-md px-3 py-2 text-base font-medium'
              )}
            >
              {item.name}
            </DisclosureButton>
          ))}
        </div>
        <div class="border-t border-surface-border pt-4 pb-3 dark:border-white/10">
          <div class="flex items-center px-4">
            <div class="shrink-0">
              <img
                alt=""
                src={userImageAlt}
                class="size-10 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
            </div>
            <div class="ml-3">
              <div class="text-base font-medium text-text-primary dark:text-white">{user.name}</div>
              <div class="text-sm font-medium text-text-tertiary">{user.email}</div>
            </div>
            <button
              type="button"
              class="relative ml-auto shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
            >
              <span class="absolute -inset-1.5" />
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
          </div>
          <div class="mt-3 space-y-1 px-2">
            {userNavigation.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                class="block rounded-md px-3 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
}

function WithSearchInColumnLayout() {
  return (
    <>
      <Popover
        as="header"
        class="relative bg-surface-0 shadow-xs data-open:fixed data-open:inset-0 data-open:z-40 data-open:overflow-y-auto lg:overflow-y-visible data-open:lg:overflow-y-visible dark:bg-surface-2/50 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10 dark:data-open:after:absolute dark:data-open:after:inset-x-0 dark:data-open:after:bottom-0"
      >
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="relative flex justify-between lg:gap-8 xl:grid xl:grid-cols-12">
            <div class="flex md:absolute md:inset-y-0 md:left-0 lg:static xl:col-span-2">
              <div class="flex shrink-0 items-center">
                <a href="#">
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
                </a>
              </div>
            </div>
            <div class="min-w-0 flex-1 md:px-8 lg:px-0 xl:col-span-6">
              <div class="flex items-center px-6 py-3.5 md:mx-auto md:max-w-3xl lg:mx-0 lg:max-w-none xl:px-0">
                <div class="grid w-full grid-cols-1">
                  <input
                    name="search"
                    placeholder="Search"
                    class="col-start-1 row-start-1 block w-full rounded-md bg-surface-0 py-1.5 pr-3 pl-10 text-base text-text-primary outline outline-surface-border placeholder:text-text-tertiary focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-accent-500"
                  />
                  <Search
                    aria-hidden="true"
                    class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-text-tertiary"
                  />
                </div>
              </div>
            </div>
            <div class="flex items-center md:absolute md:inset-y-0 md:right-0 lg:hidden">
              <PopoverButton class="group relative -mx-2 inline-flex items-center justify-center rounded-md p-2 text-text-tertiary hover:bg-surface-1 hover:text-text-secondary focus:outline-2 focus:-outline-offset-1 focus:outline-accent-500 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white dark:focus:outline-accent-500">
                <span class="absolute -inset-0.5" />
                <span class="sr-only">Open menu</span>
                <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
                <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
              </PopoverButton>
            </div>
            <div class="hidden lg:flex lg:items-center lg:justify-end xl:col-span-4">
              <button
                type="button"
                class="relative ml-5 shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-5 shrink-0">
                <MenuButton class="relative flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={userImageAlt}
                    class="size-8 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-0 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:outline-white/10"
                >
                  {userNavigation.map((item) => (
                    <MenuItem key={item.name}>
                      <a
                        href={item.href}
                        class="block px-4 py-2 text-sm text-text-secondary data-focus:bg-surface-1 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                      >
                        {item.name}
                      </a>
                    </MenuItem>
                  ))}
                </MenuItems>
              </Menu>

              <a
                href="#"
                class="ml-6 inline-flex items-center rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-500"
              >
                New Project
              </a>
            </div>
          </div>
        </div>

        <PopoverPanel
          as="nav"
          aria-label="Global"
          class="absolute relative left-1/2 z-10 mt-2 w-full -translate-x-1/2 lg:hidden dark:bg-surface-2 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-surface-2/50"
        >
          <div class="relative mx-auto max-w-3xl space-y-1 px-2 pt-2 pb-3 sm:px-4">
            <a
              href="#"
              class="block rounded-md bg-surface-1 px-3 py-2 text-base font-medium text-text-primary dark:bg-white/5 dark:text-white"
            >
              Dashboard
            </a>
            <a
              href="#"
              class="block rounded-md px-3 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Calendar
            </a>
            <a
              href="#"
              class="block rounded-md px-3 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Teams
            </a>
            <a
              href="#"
              class="block rounded-md px-3 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
            >
              Directory
            </a>
          </div>
          <div class="relative border-t border-surface-border pt-4 pb-3 dark:border-white/10">
            <div class="mx-auto flex max-w-3xl items-center px-4 sm:px-6">
              <div class="shrink-0">
                <img
                  alt=""
                  src={userImageAlt}
                  class="size-10 rounded-full bg-surface-1 outline outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </div>
              <div class="ml-3">
                <div class="text-base font-medium text-text-primary dark:text-white">
                  {user.name}
                </div>
                <div class="text-sm font-medium text-text-tertiary">{user.email}</div>
              </div>
              <button
                type="button"
                class="relative ml-auto shrink-0 rounded-full p-1 text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>
            </div>
            <div class="mx-auto mt-3 max-w-3xl space-y-1 px-2 sm:px-4">
              {userNavigation.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  class="block rounded-md px-3 py-2 text-base font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
                >
                  {item.name}
                </a>
              ))}
            </div>
          </div>
        </PopoverPanel>
      </Popover>
    </>
  );
}

export function NavbarsDemo() {
  return (
    <div class="flex flex-col gap-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Simple dark with menu button on left
        </h3>
        <div class="rounded-lg border border-surface-border bg-surface-2 dark:bg-surface-2/50">
          <SimpleDarkWithMenuButtonOnLeft />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Dark with quick action</h3>
        <div class="rounded-lg border border-surface-border bg-surface-2 dark:bg-surface-2/50">
          <DarkWithQuickAction />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple dark</h3>
        <div class="rounded-lg border border-surface-border bg-surface-2 dark:bg-surface-2/50">
          <SimpleDark />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple with menu button on left</h3>
        <div class="rounded-lg border border-surface-border bg-surface-0 dark:bg-surface-2/50">
          <SimpleWithMenuButtonOnLeft />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple</h3>
        <div class="rounded-lg border border-surface-border bg-surface-0 dark:bg-surface-2/50">
          <SimpleNavbar />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With quick action</h3>
        <div class="rounded-lg border border-surface-border bg-surface-0 dark:bg-surface-2/50">
          <WithQuickAction />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Dark with search</h3>
        <div class="rounded-lg border border-surface-border bg-surface-2 dark:bg-surface-2/50">
          <DarkWithSearch />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With search</h3>
        <div class="rounded-lg border border-surface-border bg-surface-0 dark:bg-surface-2/50">
          <WithSearch />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Dark with centered search and secondary links
        </h3>
        <div class="rounded-lg border border-surface-border bg-surface-2 dark:bg-surface-2/50">
          <DarkWithCenteredSearchAndSecondaryLinks />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          With centered search and secondary links
        </h3>
        <div class="rounded-lg border border-surface-border bg-surface-0 dark:bg-surface-2/50">
          <WithCenteredSearchAndSecondaryLinks />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With search in column layout</h3>
        <div class="rounded-lg border border-surface-border bg-surface-0 dark:bg-surface-2/50">
          <WithSearchInColumnLayout />
        </div>
      </div>
    </div>
  );
}
