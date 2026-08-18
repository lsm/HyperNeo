import { useState } from 'preact/hooks';
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
} from '../../../../src/mod.ts';
import { classNames } from '../../../../src/internal/class-names.ts';
import { Menu as MenuIcon, X, Bell, Search } from 'lucide-preact';

const user = {
  name: 'Tom Cook',
  email: 'tom@example.com',
  imageUrl:
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
};
const navigation = [
  { name: 'Home', href: '#', current: true },
  { name: 'Profile', href: '#', current: false },
  { name: 'Resources', href: '#', current: false },
  { name: 'Company Directory', href: '#', current: false },
  { name: 'Openings', href: '#', current: false },
];
const userNavigation = [
  { name: 'Your profile', href: '#' },
  { name: 'Settings', href: '#' },
  { name: 'Sign out', href: '#' },
];

function StackedWithBottomBorder() {
  const [_open, setOpen] = useState(false);

  return (
    <div class="min-h-full">
      <header class="bg-accent-600 pb-24 dark:bg-accent-800">
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:max-w-7xl lg:px-8">
          <div class="relative flex items-center justify-center py-5 lg:justify-between">
            <div class="absolute left-0 shrink-0 lg:static">
              <a href="#">
                <span class="sr-only">Your Company</span>
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=300"
                  class="h-8 w-auto"
                />
              </a>
            </div>

            <div class="hidden lg:ml-4 lg:flex lg:items-center lg:pr-0.5">
              <button
                type="button"
                class="relative shrink-0 rounded-full p-1 text-accent-200 hover:text-white focus:outline-2 focus:outline-white"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-4 shrink-0">
                <MenuButton class="relative flex max-w-xs items-center rounded-full bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={user.imageUrl}
                    class="size-8 rounded-full outline -outline-offset-1 outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 -mr-2 w-48 origin-top-right rounded-md bg-surface-1 py-1 shadow-lg outline outline-black/5 data-leave:transition data-leave:duration-75 data-leave:ease-in data-closed:data-leave:scale-95 data-closed:data-leave:transform data-closed:data-leave:opacity-0 dark:bg-gray-800 dark:-outline-offset-1 dark:outline-white/10"
                >
                  {userNavigation.map((item) => (
                    <MenuItem key={item.name}>
                      <a
                        href={item.href}
                        class="block px-4 py-2 text-sm text-text-primary data-focus:bg-surface-2 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                      >
                        {item.name}
                      </a>
                    </MenuItem>
                  ))}
                </MenuItems>
              </Menu>
            </div>

            <div class="min-w-0 flex-1 px-12 lg:hidden">
              <div class="mx-auto grid w-full max-w-xs grid-cols-1">
                <input
                  name="search"
                  placeholder="Search"
                  aria-label="Search"
                  class="col-start-1 row-start-1 block w-full rounded-md bg-accent-500/75 py-1.5 pr-3 pl-10 text-base text-white outline-1 -outline-offset-1 outline-white/10 placeholder:text-white/75 focus:outline-2 focus:-outline-offset-2 focus:outline-white sm:text-sm/6 dark:bg-accent-700/50 dark:outline-accent-400/25 dark:placeholder:text-white/50"
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-white/75 dark:text-white/50"
                />
              </div>
            </div>

            <div class="absolute right-0 shrink-0 lg:hidden">
              <button
                type="button"
                onClick={() => setOpen(true)}
                class="relative inline-flex items-center justify-center rounded-md bg-transparent p-2 text-accent-200 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                <span class="absolute -inset-0.5" />
                <span class="sr-only">Open main menu</span>
                <MenuIcon aria-hidden="true" class="size-6" />
              </button>
            </div>
          </div>
          <div class="hidden border-t border-white/20 py-5 lg:block dark:border-white/10">
            <div class="grid grid-cols-3 items-center gap-8">
              <div class="col-span-2">
                <nav class="flex space-x-4">
                  {navigation.map((item) => (
                    <a
                      key={item.name}
                      href={item.href}
                      aria-current={item.current ? 'page' : undefined}
                      class={classNames(
                        item.current ? 'text-white' : 'text-accent-100',
                        'rounded-md px-3 py-2 text-sm font-medium hover:bg-accent-500/75 dark:hover:bg-accent-700/75'
                      )}
                    >
                      {item.name}
                    </a>
                  ))}
                </nav>
              </div>
              <div class="mx-auto grid w-full max-w-md grid-cols-1">
                <input
                  name="search"
                  placeholder="Search"
                  aria-label="Search"
                  class="col-start-1 row-start-1 block w-full rounded-md bg-accent-500/75 py-1.5 pr-3 pl-10 text-base text-white outline-1 -outline-offset-1 outline-white/10 placeholder:text-white/75 focus:outline-2 focus:-outline-offset-2 focus:outline-white sm:text-sm/6 dark:bg-accent-700/50 dark:outline-accent-400/25 dark:placeholder:text-white/50"
                />
                <Search
                  aria-hidden="true"
                  class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-white/75 dark:text-white/50"
                />
              </div>
            </div>
          </div>
        </div>

        <Disclosure as="nav" class="lg:hidden">
          {() => (
            <>
              <DisclosurePanel
                transition
                class="fixed inset-0 z-20 bg-black/25 duration-150 data-closed:opacity-0 data-enter:ease-out data-leave:ease-in"
              >
                <div class="absolute inset-x-0 top-0 z-30 mx-auto w-full max-w-3xl origin-top transform p-2 transition duration-150 data-closed:scale-95 data-closed:opacity-0 data-enter:ease-out data-leave:ease-in">
                  <div class="divide-y divide-gray-200 rounded-lg bg-surface-1 shadow-lg outline outline-black/5 dark:divide-white/10 dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10">
                    <div class="pt-3 pb-2">
                      <div class="flex items-center justify-between px-4">
                        <div>
                          <img
                            alt="Your Company"
                            src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                            class="h-8 w-auto dark:hidden"
                          />
                          <img
                            alt="Your Company"
                            src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                            class="h-8 w-auto not-dark:hidden"
                          />
                        </div>
                        <div class="-mr-2">
                          <DisclosureButton class="relative inline-flex items-center justify-center rounded-md bg-surface-1 p-2 text-gray-400 hover:bg-surface-2 hover:text-gray-500 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-white dark:bg-gray-800 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:outline-white">
                            <span class="absolute -inset-0.5" />
                            <span class="sr-only">Close menu</span>
                            <X aria-hidden="true" class="size-6" />
                          </DisclosureButton>
                        </div>
                      </div>
                      <div class="mt-3 space-y-1 px-2">
                        {navigation.map((item) => (
                          <DisclosureButton
                            key={item.name}
                            as="a"
                            href={item.href}
                            class="block rounded-md px-3 py-2 text-base font-medium text-text-primary hover:bg-surface-2 hover:text-text-secondary dark:text-gray-100 dark:hover:bg-white/5 dark:hover:text-white"
                          >
                            {item.name}
                          </DisclosureButton>
                        ))}
                      </div>
                    </div>
                    <div class="pt-4 pb-2">
                      <div class="flex items-center px-5">
                        <div class="shrink-0">
                          <img
                            alt=""
                            src={user.imageUrl}
                            class="size-10 rounded-full outline -outline-offset-1 outline-black/5 dark:outline-white/10"
                          />
                        </div>
                        <div class="ml-3 min-w-0 flex-1">
                          <div class="truncate text-base font-medium text-text-primary dark:text-gray-200">
                            {user.name}
                          </div>
                          <div class="truncate text-sm font-medium text-text-muted dark:text-gray-400">
                            {user.email}
                          </div>
                        </div>
                        <button
                          type="button"
                          class="relative ml-auto shrink-0 rounded-full p-1 text-gray-400 hover:text-gray-500 focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:text-gray-400 dark:hover:text-white dark:focus:outline-white"
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
                            class="block rounded-md px-3 py-2 text-base font-medium text-text-primary hover:bg-surface-2 hover:text-text-secondary dark:text-gray-100 dark:hover:bg-white/5 dark:hover:text-white"
                          >
                            {item.name}
                          </DisclosureButton>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </DisclosurePanel>
            </>
          )}
        </Disclosure>
      </header>
      <main class="-mt-24 pb-8">
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:max-w-7xl lg:px-8">
          <h1 class="sr-only">Page title</h1>
          <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:gap-8">
            <div class="grid grid-cols-1 gap-4 lg:col-span-2">
              <section aria-labelledby="section-1-title">
                <h2 id="section-1-title" class="sr-only">
                  Section title
                </h2>
                <div class="overflow-hidden rounded-lg bg-surface-1 shadow-sm dark:bg-gray-800 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
                  <div class="p-6" />
                </div>
              </section>
            </div>
            <div class="grid grid-cols-1 gap-4">
              <section aria-labelledby="section-2-title">
                <h2 id="section-2-title" class="sr-only">
                  Section title
                </h2>
                <div class="overflow-hidden rounded-lg bg-surface-1 shadow-sm dark:bg-gray-800 dark:shadow-none dark:inset-ring dark:inset-ring-white/10">
                  <div class="p-6" />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
      <footer>
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:max-w-7xl lg:px-8">
          <div class="border-t border-surface-border py-8 text-center text-sm text-text-muted sm:text-left">
            <span class="block sm:inline">2021 Your Company, Inc.</span>{' '}
            <span class="block sm:inline">All rights reserved.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StackedWithLighterPageHeader() {
  return (
    <div class="min-h-full">
      <Disclosure
        as="nav"
        class="border-b border-surface-border bg-surface-1 dark:border-white/10 dark:bg-gray-900"
      >
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="flex h-16 justify-between">
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
                  class="h-8 w-auto not-dark:hidden"
                />
              </div>
              <div class="hidden sm:-my-px sm:ml-6 sm:flex sm:space-x-8">
                {navigation.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    aria-current={item.current ? 'page' : undefined}
                    class={classNames(
                      item.current
                        ? 'border-accent-500 text-text-primary dark:border-accent-500 dark:text-white'
                        : 'border-transparent text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-gray-200',
                      'inline-flex items-center border-b-2 px-1 pt-1 text-sm font-medium'
                    )}
                  >
                    {item.name}
                  </a>
                ))}
              </div>
            </div>
            <div class="hidden sm:ml-6 sm:flex sm:items-center">
              <button
                type="button"
                class="relative rounded-full p-1 text-text-secondary hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-600 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>

              <Menu as="div" class="relative ml-3">
                <MenuButton class="relative flex max-w-xs items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 dark:focus-visible:outline-accent-500">
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">Open user menu</span>
                  <img
                    alt=""
                    src={user.imageUrl}
                    class="size-8 rounded-full outline -outline-offset-1 outline-black/5 dark:outline-white/10"
                  />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-1 py-1 shadow-lg outline outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-200 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                >
                  {userNavigation.map((item) => (
                    <MenuItem key={item.name}>
                      <a
                        href={item.href}
                        class="block px-4 py-2 text-sm text-text-primary data-focus:bg-surface-2 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                      >
                        {item.name}
                      </a>
                    </MenuItem>
                  ))}
                </MenuItems>
              </Menu>
            </div>
            <div class="-mr-2 flex items-center sm:hidden">
              <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md bg-surface-1 p-2 text-text-secondary hover:bg-surface-2 hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-600 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white dark:focus:outline-accent-500">
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
            {navigation.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
                class={classNames(
                  item.current
                    ? 'border-accent-500 bg-accent-500/10 text-accent-700 dark:border-accent-500 dark:bg-accent-600/10 dark:text-accent-300'
                    : 'border-transparent text-text-secondary hover:border-surface-border hover:bg-surface-2 hover:text-text-primary dark:text-gray-400 dark:hover:border-gray-500 dark:hover:bg-white/5 dark:hover:text-gray-200',
                  'block border-l-4 py-2 pr-4 pl-3 text-base font-medium'
                )}
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
          <div class="border-t border-surface-border pt-4 pb-3 dark:border-gray-700">
            <div class="flex items-center px-4">
              <div class="shrink-0">
                <img
                  alt=""
                  src={user.imageUrl}
                  class="size-10 rounded-full outline -outline-offset-1 outline-black/5 dark:outline-white/10"
                />
              </div>
              <div class="ml-3">
                <div class="text-base font-medium text-text-primary dark:text-white">
                  {user.name}
                </div>
                <div class="text-sm font-medium text-text-muted dark:text-gray-400">
                  {user.email}
                </div>
              </div>
              <button
                type="button"
                class="relative ml-auto shrink-0 rounded-full p-1 text-text-secondary hover:text-text-primary focus:outline-2 focus:outline-offset-2 focus:outline-accent-600 dark:text-gray-400 dark:hover:text-white dark:focus:outline-accent-500"
              >
                <span class="absolute -inset-1.5" />
                <span class="sr-only">View notifications</span>
                <Bell aria-hidden="true" class="size-6" />
              </button>
            </div>
            <div class="mt-3 space-y-1">
              {userNavigation.map((item) => (
                <DisclosureButton
                  key={item.name}
                  as="a"
                  href={item.href}
                  class="block px-4 py-2 text-base font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200"
                >
                  {item.name}
                </DisclosureButton>
              ))}
            </div>
          </div>
        </DisclosurePanel>
      </Disclosure>

      <div class="py-10">
        <header>
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h1 class="text-3xl font-bold tracking-tight text-text-primary dark:text-white">
              Dashboard
            </h1>
          </div>
        </header>
        <main>
          <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8" />
        </main>
      </div>
    </div>
  );
}

const brandedNav = [
  { name: 'Dashboard', href: '#', current: true },
  { name: 'Team', href: '#', current: false },
  { name: 'Projects', href: '#', current: false },
  { name: 'Calendar', href: '#', current: false },
  { name: 'Reports', href: '#', current: false },
];

function BrandedNavWithLighterPageHeader() {
  return (
    <div class="min-h-full">
      <Disclosure as="nav" class="bg-gray-800 dark:bg-gray-800/50">
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="flex h-16 items-center justify-between">
            <div class="flex items-center">
              <div class="shrink-0">
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                  class="size-8"
                />
              </div>
              <div class="hidden md:block">
                <div class="ml-10 flex items-baseline space-x-4">
                  {brandedNav.map((item) => (
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
            <div class="hidden md:block">
              <div class="ml-4 flex items-center md:ml-6">
                <button
                  type="button"
                  class="relative rounded-full p-1 text-gray-400 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500"
                >
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">View notifications</span>
                  <Bell aria-hidden="true" class="size-6" />
                </button>

                <Menu as="div" class="relative ml-3">
                  <MenuButton class="relative flex max-w-xs items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
                    <span class="absolute -inset-1.5" />
                    <span class="sr-only">Open user menu</span>
                    <img
                      alt=""
                      src={user.imageUrl}
                      class="size-8 rounded-full outline -outline-offset-1 outline-white/10"
                    />
                  </MenuButton>

                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-1 py-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                  >
                    {userNavigation.map((item) => (
                      <MenuItem key={item.name}>
                        <a
                          href={item.href}
                          class="block px-4 py-2 text-sm text-text-primary data-focus:bg-surface-2 data-focus:outline-hidden dark:text-gray-300 dark:data-focus:bg-white/5"
                        >
                          {item.name}
                        </a>
                      </MenuItem>
                    ))}
                  </MenuItems>
                </Menu>
              </div>
            </div>
            <div class="-mr-2 flex md:hidden">
              <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent-500">
                <span class="absolute -inset-0.5" />
                <span class="sr-only">Open main menu</span>
                <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
                <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
              </DisclosureButton>
            </div>
          </div>
        </div>

        <DisclosurePanel class="md:hidden">
          <div class="space-y-1 px-2 pt-2 pb-3 sm:px-3">
            {brandedNav.map((item) => (
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
            <div class="flex items-center px-5">
              <div class="shrink-0">
                <img
                  alt=""
                  src={user.imageUrl}
                  class="size-10 rounded-full outline -outline-offset-1 outline-white/10"
                />
              </div>
              <div class="ml-3">
                <div class="text-base/5 font-medium text-white">{user.name}</div>
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

      <header class="relative bg-surface-1 shadow-sm dark:bg-gray-800 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:inset-y-0 dark:after:border-y dark:after:border-white/10">
        <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <h1 class="text-3xl font-bold tracking-tight text-text-primary dark:text-white">
            Dashboard
          </h1>
        </div>
      </header>
      <main>
        <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8" />
      </main>
    </div>
  );
}

function TwoRowNavigationWithOverlap() {
  return (
    <div class="min-h-full">
      <Disclosure as="nav" class="bg-accent-600 dark:bg-accent-800">
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="flex h-16 items-center justify-between">
            <div class="flex items-center">
              <div class="shrink-0">
                <img
                  alt="Your Company"
                  src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=300"
                  class="size-8"
                />
              </div>
              <div class="hidden md:block">
                <div class="ml-10 flex items-baseline space-x-4">
                  {brandedNav.map((item) => (
                    <a
                      key={item.name}
                      href={item.href}
                      aria-current={item.current ? 'page' : undefined}
                      class={classNames(
                        item.current
                          ? 'bg-accent-700 text-white dark:bg-accent-950/40'
                          : 'text-white hover:bg-accent-500/75 dark:hover:bg-accent-700/75',
                        'rounded-md px-3 py-2 text-sm font-medium'
                      )}
                    >
                      {item.name}
                    </a>
                  ))}
                </div>
              </div>
            </div>
            <div class="hidden md:block">
              <div class="ml-4 flex items-center md:ml-6">
                <button
                  type="button"
                  class="relative rounded-full p-1 text-accent-200 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-white"
                >
                  <span class="absolute -inset-1.5" />
                  <span class="sr-only">View notifications</span>
                  <Bell aria-hidden="true" class="size-6" />
                </button>

                <Menu as="div" class="relative ml-3">
                  <MenuButton class="relative flex max-w-xs items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                    <span class="absolute -inset-1.5" />
                    <span class="sr-only">Open user menu</span>
                    <img
                      alt=""
                      src={user.imageUrl}
                      class="size-8 rounded-full outline -outline-offset-1 outline-white/10"
                    />
                  </MenuButton>

                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-1 py-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                  >
                    {userNavigation.map((item) => (
                      <MenuItem key={item.name}>
                        <a
                          href={item.href}
                          class="block px-4 py-2 text-sm text-text-primary data-focus:bg-surface-2 data-focus:outline-hidden dark:text-gray-200 dark:data-focus:bg-white/5"
                        >
                          {item.name}
                        </a>
                      </MenuItem>
                    ))}
                  </MenuItems>
                </Menu>
              </div>
            </div>
            <div class="-mr-2 flex md:hidden">
              <DisclosureButton class="group relative inline-flex items-center justify-center rounded-md bg-accent-600 p-2 text-accent-200 hover:bg-accent-500/75 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-white dark:bg-accent-800 dark:hover:bg-accent-700/75">
                <span class="absolute -inset-0.5" />
                <span class="sr-only">Open main menu</span>
                <MenuIcon aria-hidden="true" class="block size-6 group-data-open:hidden" />
                <X aria-hidden="true" class="hidden size-6 group-data-open:block" />
              </DisclosureButton>
            </div>
          </div>
        </div>

        <DisclosurePanel class="md:hidden">
          <div class="space-y-1 px-2 pt-2 pb-3 sm:px-3">
            {brandedNav.map((item) => (
              <DisclosureButton
                key={item.name}
                as="a"
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
                class={classNames(
                  item.current
                    ? 'bg-accent-700 text-white dark:bg-accent-950/40'
                    : 'text-white hover:bg-accent-500/75 dark:hover:bg-accent-700/75',
                  'block rounded-md px-3 py-2 text-base font-medium'
                )}
              >
                {item.name}
              </DisclosureButton>
            ))}
          </div>
          <div class="border-t border-accent-700 pt-4 pb-3 dark:border-accent-800">
            <div class="flex items-center px-5">
              <div class="shrink-0">
                <img
                  alt=""
                  src={user.imageUrl}
                  class="size-10 rounded-full outline -outline-offset-1 outline-white/10"
                />
              </div>
              <div class="ml-3">
                <div class="text-base font-medium text-white">{user.name}</div>
                <div class="text-sm font-medium text-accent-300">{user.email}</div>
              </div>
              <button
                type="button"
                class="relative ml-auto shrink-0 rounded-full p-1 text-accent-200 hover:text-white focus:outline-2 focus:outline-offset-2 focus:outline-white"
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
                  class="block rounded-md px-3 py-2 text-base font-medium text-white hover:bg-accent-500/75 dark:hover:bg-accent-700/75"
                >
                  {item.name}
                </DisclosureButton>
              ))}
            </div>
          </div>
        </DisclosurePanel>
      </Disclosure>

      <header class="relative bg-surface-1 shadow-sm dark:bg-gray-800 dark:shadow-none dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:bottom-0 dark:after:h-px dark:after:bg-white/10">
        <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <h1 class="text-3xl font-bold tracking-tight text-text-primary dark:text-white">
            Dashboard
          </h1>
        </div>
      </header>
      <main>
        <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8" />
      </main>
    </div>
  );
}

export function StackedShellsDemo() {
  return (
    <div class="flex flex-col gap-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Stacked with bottom border</h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <StackedWithBottomBorder />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Stacked with lighter page header
        </h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <StackedWithLighterPageHeader />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Branded nav with lighter page header
        </h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <BrandedNavWithLighterPageHeader />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Two row navigation with overlap</h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <TwoRowNavigationWithOverlap />
        </div>
      </div>
    </div>
  );
}
