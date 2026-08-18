import { useState } from 'preact/hooks';
import { Dialog, DialogBackdrop, DialogPanel, Transition, TransitionChild } from '../../src/mod.ts';
import {
  BarChart3,
  Bell,
  Box,
  ChevronDown,
  CreditCard,
  Fingerprint,
  Folder,
  Globe,
  Menu,
  Search,
  Server,
  Settings,
  Signal,
  UserCircle,
  Users,
  X,
} from 'lucide-preact';

function SettingsScreensSidebar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [automaticTimezone, setAutomaticTimezone] = useState(true);

  const navigation = [
    { name: 'Home', href: '#' },
    { name: 'Invoices', href: '#' },
    { name: 'Clients', href: '#' },
    { name: 'Expenses', href: '#' },
  ];
  const secondaryNavigation = [
    { name: 'General', href: '#', icon: UserCircle, current: true },
    { name: 'Security', href: '#', icon: Fingerprint, current: false },
    { name: 'Notifications', href: '#', icon: Bell, current: false },
    { name: 'Plan', href: '#', icon: Box, current: false },
    { name: 'Billing', href: '#', icon: CreditCard, current: false },
    { name: 'Team members', href: '#', icon: Users, current: false },
  ];

  function classNames(...classes: (string | boolean | undefined)[]): string {
    return classes.filter(Boolean).join(' ');
  }

  return (
    <div class="bg-white dark:bg-gray-900">
      <header class="absolute inset-x-0 top-0 z-50 flex h-16 border-b border-gray-900/10 dark:border-white/10 dark:bg-black/10">
        <div class="mx-auto flex w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div class="flex flex-1 items-center gap-x-6">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              class="-m-3 p-3 md:hidden"
            >
              <span class="sr-only">Open main menu</span>
              <Menu aria-hidden="true" class="size-5 text-gray-900 dark:text-white" />
            </button>
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
          <nav class="hidden md:flex md:gap-x-11 md:text-sm/6 md:font-semibold md:text-gray-700 dark:md:text-gray-300">
            {navigation.map((item, itemIdx) => (
              <a key={itemIdx} href={item.href}>
                {item.name}
              </a>
            ))}
          </nav>
          <div class="flex flex-1 items-center justify-end gap-x-8">
            <button
              type="button"
              class="-m-2.5 p-2.5 text-gray-400 hover:text-gray-500 dark:text-gray-400 dark:hover:text-white"
            >
              <span class="sr-only">View notifications</span>
              <Bell aria-hidden="true" class="size-6" />
            </button>
            <a href="#" class="-m-1.5 p-1.5">
              <span class="sr-only">Your profile</span>
              <img
                alt=""
                src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                class="size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
              />
            </a>
          </div>
        </div>
        <Dialog open={mobileMenuOpen} onClose={setMobileMenuOpen} class="lg:hidden">
          <div class="fixed inset-0 z-50" />
          <DialogPanel class="fixed inset-y-0 left-0 z-50 w-full overflow-y-auto bg-white px-4 pb-6 sm:max-w-sm sm:px-6 sm:ring-1 sm:ring-gray-900/10 dark:bg-gray-900 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10 dark:sm:ring-white/10">
            <div class="relative -ml-0.5 flex h-16 items-center gap-x-6">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                class="-m-2.5 p-2.5 text-gray-700 dark:text-gray-400"
              >
                <span class="sr-only">Close menu</span>
                <X aria-hidden="true" class="size-6" />
              </button>
              <div class="-ml-0.5">
                <a href="#" class="-m-1.5 block p-1.5">
                  <span class="sr-only">Your Company</span>
                  <img
                    alt=""
                    src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=600"
                    class="h-8 w-auto dark:hidden"
                  />
                  <img
                    alt=""
                    src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
                    class="h-8 w-auto not-dark:hidden"
                  />
                </a>
              </div>
            </div>
            <div class="mt-2 space-y-2">
              {navigation.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  class="-mx-3 block rounded-lg px-3 py-2 text-base/7 font-semibold text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-white/5"
                >
                  {item.name}
                </a>
              ))}
            </div>
          </DialogPanel>
        </Dialog>
      </header>

      <div class="mx-auto max-w-7xl pt-16 lg:flex lg:gap-x-16 lg:px-8">
        <h1 class="sr-only">General Settings</h1>

        <aside class="flex overflow-x-auto border-b border-gray-900/5 py-4 lg:block lg:w-64 lg:flex-none lg:border-0 lg:py-20 dark:border-white/10">
          <nav class="flex-none px-4 sm:px-6 lg:px-0">
            <ul role="list" class="flex gap-x-3 gap-y-1 whitespace-nowrap lg:flex-col">
              {secondaryNavigation.map((item) => (
                <li key={item.name}>
                  <a
                    href={item.href}
                    class={classNames(
                      item.current
                        ? 'bg-gray-50 text-indigo-600 dark:bg-white/5 dark:text-white'
                        : 'text-gray-700 hover:bg-gray-50 hover:text-indigo-600 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white',
                      'group flex gap-x-3 rounded-md py-2 pr-3 pl-2 text-sm/6 font-semibold'
                    )}
                  >
                    <item.icon
                      aria-hidden="true"
                      class={classNames(
                        item.current
                          ? 'text-indigo-600 dark:text-white'
                          : 'text-gray-400 group-hover:text-indigo-600 dark:text-gray-500 dark:group-hover:text-white',
                        'size-6 shrink-0'
                      )}
                    />
                    {item.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <main class="px-4 py-16 sm:px-6 lg:flex-auto lg:px-0 lg:py-20">
          <div class="mx-auto max-w-2xl space-y-16 sm:space-y-20 lg:mx-0 lg:max-w-none">
            <div>
              <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">Profile</h2>
              <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                This information will be displayed publicly so be careful what you share.
              </p>

              <dl class="mt-6 divide-y divide-gray-100 border-t border-gray-200 text-sm/6 dark:divide-white/5 dark:border-white/5">
                <div class="py-6 sm:flex">
                  <dt class="font-medium text-gray-900 sm:w-64 sm:flex-none sm:pr-6 dark:text-white">
                    Full name
                  </dt>
                  <dd class="mt-1 flex justify-between gap-x-6 sm:mt-0 sm:flex-auto">
                    <div class="text-gray-900 dark:text-gray-300">Tom Cook</div>
                    <button
                      type="button"
                      class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      Update
                    </button>
                  </dd>
                </div>
                <div class="py-6 sm:flex">
                  <dt class="font-medium text-gray-900 sm:w-64 sm:flex-none sm:pr-6 dark:text-white">
                    Email address
                  </dt>
                  <dd class="mt-1 flex justify-between gap-x-6 sm:mt-0 sm:flex-auto">
                    <div class="text-gray-900 dark:text-gray-300">tom.cook@example.com</div>
                    <button
                      type="button"
                      class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      Update
                    </button>
                  </dd>
                </div>
                <div class="py-6 sm:flex">
                  <dt class="font-medium text-gray-900 sm:w-64 sm:flex-none sm:pr-6 dark:text-white">
                    Title
                  </dt>
                  <dd class="mt-1 flex justify-between gap-x-6 sm:mt-0 sm:flex-auto">
                    <div class="text-gray-900 dark:text-gray-300">Human Resources Manager</div>
                    <button
                      type="button"
                      class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      Update
                    </button>
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">Bank accounts</h2>
              <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                Connect bank accounts to your account.
              </p>

              <ul
                role="list"
                class="mt-6 divide-y divide-gray-100 border-t border-gray-200 text-sm/6 dark:divide-white/5 dark:border-white/5"
              >
                <li class="flex justify-between gap-x-6 py-6">
                  <div class="font-medium text-gray-900 dark:text-white">TD Canada Trust</div>
                  <button
                    type="button"
                    class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                  >
                    Update
                  </button>
                </li>
                <li class="flex justify-between gap-x-6 py-6">
                  <div class="font-medium text-gray-900 dark:text-white">Royal Bank of Canada</div>
                  <button
                    type="button"
                    class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                  >
                    Update
                  </button>
                </li>
              </ul>

              <div class="flex border-t border-gray-100 pt-6 dark:border-white/5">
                <button
                  type="button"
                  class="text-sm/6 font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  <span aria-hidden="true">+</span> Add another bank
                </button>
              </div>
            </div>

            <div>
              <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">Integrations</h2>
              <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                Connect applications to your account.
              </p>

              <ul
                role="list"
                class="mt-6 divide-y divide-gray-100 border-t border-gray-200 text-sm/6 dark:divide-white/5 dark:border-white/5"
              >
                <li class="flex justify-between gap-x-6 py-6">
                  <div class="font-medium text-gray-900 dark:text-white">QuickBooks</div>
                  <button
                    type="button"
                    class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                  >
                    Update
                  </button>
                </li>
              </ul>

              <div class="flex border-t border-gray-100 pt-6 dark:border-white/5">
                <button
                  type="button"
                  class="text-sm/6 font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  <span aria-hidden="true">+</span> Add another application
                </button>
              </div>
            </div>

            <div>
              <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">
                Language and dates
              </h2>
              <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                Choose what language and date format to use throughout your account.
              </p>

              <dl class="mt-6 divide-y divide-gray-100 border-t border-gray-200 text-sm/6 dark:divide-white/5 dark:border-white/5">
                <div class="py-6 sm:flex">
                  <dt class="font-medium text-gray-900 sm:w-64 sm:flex-none sm:pr-6 dark:text-white">
                    Language
                  </dt>
                  <dd class="mt-1 flex justify-between gap-x-6 sm:mt-0 sm:flex-auto">
                    <div class="text-gray-900 dark:text-gray-300">English</div>
                    <button
                      type="button"
                      class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      Update
                    </button>
                  </dd>
                </div>
                <div class="py-6 sm:flex">
                  <dt class="font-medium text-gray-900 sm:w-64 sm:flex-none sm:pr-6 dark:text-white">
                    Date format
                  </dt>
                  <dd class="mt-1 flex justify-between gap-x-6 sm:mt-0 sm:flex-auto">
                    <div class="text-gray-900 dark:text-gray-300">DD-MM-YYYY</div>
                    <button
                      type="button"
                      class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      Update
                    </button>
                  </dd>
                </div>
                <div class="flex pt-6">
                  <dt class="font-medium text-gray-900 sm:w-64 sm:flex-none sm:pr-6 dark:text-white">
                    Automatic timezone
                  </dt>
                  <dd class="flex flex-auto items-center justify-end">
                    <div
                      onClick={() => setAutomaticTimezone(!automaticTimezone)}
                      class={classNames(
                        automaticTimezone
                          ? 'bg-indigo-600 dark:bg-indigo-500'
                          : 'bg-gray-200 dark:bg-white/5',
                        'relative inline-flex w-8 shrink-0 rounded-full p-px ring-1 ring-inset ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out cursor-pointer dark:ring-white/10 dark:outline-indigo-500'
                      )}
                    >
                      <span
                        class={classNames(
                          automaticTimezone ? 'translate-x-3.5' : 'translate-x-0',
                          'size-4 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out'
                        )}
                      />
                      <input
                        type="checkbox"
                        checked={automaticTimezone}
                        onChange={() => setAutomaticTimezone(!automaticTimezone)}
                        name="automatic-timezone"
                        aria-label="Automatic timezone"
                        class="sr-only"
                      />
                    </div>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function SettingsScreensStacked() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navigation = [
    { name: 'Projects', href: '#', icon: Folder, current: false },
    { name: 'Deployments', href: '#', icon: Server, current: false },
    { name: 'Activity', href: '#', icon: Signal, current: false },
    { name: 'Domains', href: '#', icon: Globe, current: false },
    { name: 'Usage', href: '#', icon: BarChart3, current: false },
    { name: 'Settings', href: '#', icon: Settings, current: true },
  ];
  const teams = [
    { id: 1, name: 'Planetaria', href: '#', initial: 'P', current: false },
    { id: 2, name: 'Protocol', href: '#', initial: 'P', current: false },
    { id: 3, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  ];
  const secondaryNavigation = [
    { name: 'Account', href: '#', current: true },
    { name: 'Notifications', href: '#', current: false },
    { name: 'Billing', href: '#', current: false },
    { name: 'Teams', href: '#', current: false },
    { name: 'Integrations', href: '#', current: false },
  ];

  function classNames(...classes: (string | boolean | undefined)[]): string {
    return classes.filter(Boolean).join(' ');
  }

  return (
    <div class="bg-white dark:bg-gray-900">
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 xl:hidden">
        <Transition show={sidebarOpen}>
          <DialogBackdrop
            transition
            class="fixed inset-0 bg-gray-900/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
          />
        </Transition>

        <div class="fixed inset-0 flex">
          <Transition show={sidebarOpen}>
            <DialogPanel
              transition
              class="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-[closed]:-translate-x-full"
            >
              <TransitionChild
                enter="transition duration-300 ease-in-out"
                enterFrom="opacity-0"
                enterTo="opacity-100"
                leave="transition duration-300 ease-in-out"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
              >
                <div class="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-[closed]:opacity-0">
                  <button type="button" onClick={() => setSidebarOpen(false)} class="-m-2.5 p-2.5">
                    <span class="sr-only">Close sidebar</span>
                    <X aria-hidden="true" class="size-6 text-white" />
                  </button>
                </div>
              </TransitionChild>

              <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-gray-50 px-6 dark:bg-gray-900 dark:ring dark:ring-white/10 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
                <div class="relative flex h-16 shrink-0 items-center">
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
                                  ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                                  : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                              )}
                            >
                              <item.icon
                                aria-hidden="true"
                                class={classNames(
                                  item.current
                                    ? 'text-indigo-600 dark:text-white'
                                    : 'text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-white',
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
                      <div class="text-xs/6 font-semibold text-gray-400 dark:text-gray-400">
                        Your teams
                      </div>
                      <ul role="list" class="-mx-2 mt-2 space-y-1">
                        {teams.map((team) => (
                          <li key={team.name}>
                            <a
                              href={team.href}
                              class={classNames(
                                team.current
                                  ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                                  : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                              )}
                            >
                              <span
                                class={classNames(
                                  team.current
                                    ? 'border-indigo-600 text-indigo-600 dark:border-white/20 dark:text-white'
                                    : 'border-gray-200 text-gray-400 group-hover:border-indigo-600 group-hover:text-indigo-600 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
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
                        class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-gray-900 hover:bg-gray-100 dark:text-white dark:hover:bg-white/5"
                      >
                        <img
                          alt=""
                          src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                          class="size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                        />
                        <span class="sr-only">Your profile</span>
                        <span aria-hidden="true">Tom Cook</span>
                      </a>
                    </li>
                  </ul>
                </nav>
              </div>
            </DialogPanel>
          </Transition>
        </div>
      </Dialog>

      <div class="hidden xl:fixed xl:inset-y-0 xl:z-50 xl:flex xl:w-72 xl:flex-col dark:bg-gray-900">
        <div class="flex grow flex-col gap-y-5 overflow-y-auto bg-gray-50 px-6 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/5">
          <div class="flex h-16 shrink-0 items-center">
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
                            ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <item.icon
                          aria-hidden="true"
                          class={classNames(
                            item.current
                              ? 'text-indigo-600 dark:text-white'
                              : 'text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-white',
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
                <div class="text-xs/6 font-semibold text-gray-500 dark:text-gray-400">
                  Your teams
                </div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span
                          class={classNames(
                            team.current
                              ? 'border-indigo-600 text-indigo-600 dark:border-white/20 dark:text-white'
                              : 'border-gray-200 text-gray-400 group-hover:border-indigo-600 group-hover:text-indigo-600 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
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
                  class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-gray-900 hover:bg-gray-100 dark:text-white dark:hover:bg-white/5"
                >
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                  />
                  <span class="sr-only">Your profile</span>
                  <span aria-hidden="true">Tom Cook</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="xl:pl-72">
        <div class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-6 border-b border-gray-200 bg-white px-4 shadow-xs sm:px-6 lg:px-8 dark:border-white/5 dark:bg-gray-900 dark:shadow-none">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            class="-m-2.5 p-2.5 text-gray-900 xl:hidden dark:text-white"
          >
            <span class="sr-only">Open sidebar</span>
            <Menu aria-hidden="true" class="size-5" />
          </button>

          <div class="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
            <form action="#" method="GET" class="grid flex-1 grid-cols-1">
              <input
                name="search"
                placeholder="Search"
                aria-label="Search"
                class="col-start-1 row-start-1 block size-full bg-transparent pl-8 text-base text-gray-900 outline-hidden placeholder:text-gray-400 sm:text-sm/6 dark:text-white dark:placeholder:text-gray-500"
              />
              <Search
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 size-5 self-center text-gray-400 dark:text-gray-500"
              />
            </form>
          </div>
        </div>

        <main>
          <h1 class="sr-only">Account Settings</h1>

          <header class="border-b border-gray-200 dark:border-white/5">
            <nav class="flex overflow-x-auto py-4">
              <ul
                role="list"
                class="flex min-w-full flex-none gap-x-6 px-4 text-sm/6 font-semibold text-gray-500 sm:px-6 lg:px-8 dark:text-gray-400"
              >
                {secondaryNavigation.map((item) => (
                  <li key={item.name}>
                    <a
                      href={item.href}
                      class={item.current ? 'text-indigo-600 dark:text-indigo-400' : ''}
                    >
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </header>

          <div class="divide-y divide-gray-200 dark:divide-white/10">
            <div class="grid max-w-7xl grid-cols-1 gap-x-8 gap-y-10 px-4 py-16 sm:px-6 md:grid-cols-3 lg:px-8">
              <div>
                <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">
                  Personal Information
                </h2>
                <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                  Use a permanent address where you can receive mail.
                </p>
              </div>

              <form class="md:col-span-2">
                <div class="grid grid-cols-1 gap-x-6 gap-y-8 sm:max-w-xl sm:grid-cols-6">
                  <div class="col-span-full flex items-center gap-x-8">
                    <img
                      alt=""
                      src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                      class="size-24 flex-none rounded-lg bg-gray-100 object-cover outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                    />
                    <div>
                      <button
                        type="button"
                        class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring-1 inset-ring-gray-300 hover:bg-gray-100 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
                      >
                        Change avatar
                      </button>
                      <p class="mt-2 text-xs/5 text-gray-500 dark:text-gray-400">
                        JPG, GIF or PNG. 1MB max.
                      </p>
                    </div>
                  </div>

                  <div class="sm:col-span-3">
                    <label
                      for="first-name"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      First name
                    </label>
                    <div class="mt-2">
                      <input
                        id="first-name"
                        name="first-name"
                        type="text"
                        autocomplete="given-name"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>

                  <div class="sm:col-span-3">
                    <label
                      for="last-name"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Last name
                    </label>
                    <div class="mt-2">
                      <input
                        id="last-name"
                        name="last-name"
                        type="text"
                        autocomplete="family-name"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>

                  <div class="col-span-full">
                    <label
                      for="email"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Email address
                    </label>
                    <div class="mt-2">
                      <input
                        id="email"
                        name="email"
                        type="email"
                        autocomplete="email"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>

                  <div class="col-span-full">
                    <label
                      for="username"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Username
                    </label>
                    <div class="mt-2">
                      <div class="flex items-center rounded-md bg-white pl-3 outline-1 -outline-offset-1 outline-gray-300 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:outline-white/10 dark:focus-within:outline-indigo-500">
                        <div class="shrink-0 text-base text-gray-500 select-none sm:text-sm/6 dark:text-gray-400">
                          example.com/
                        </div>
                        <input
                          id="username"
                          name="username"
                          type="text"
                          placeholder="janesmith"
                          class="block min-w-0 grow bg-transparent py-1.5 pr-3 pl-1 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-gray-500"
                        />
                      </div>
                    </div>
                  </div>

                  <div class="col-span-full">
                    <label
                      for="timezone"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Timezone
                    </label>
                    <div class="mt-2 grid grid-cols-1">
                      <select
                        id="timezone"
                        name="timezone"
                        class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:*:bg-gray-800 dark:focus:outline-indigo-500"
                      >
                        <option>Pacific Standard Time</option>
                        <option>Eastern Standard Time</option>
                        <option>Greenwich Mean Time</option>
                      </select>
                      <ChevronDown
                        aria-hidden="true"
                        class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-400 sm:size-4"
                      />
                    </div>
                  </div>
                </div>

                <div class="mt-8 flex">
                  <button
                    type="submit"
                    class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
                  >
                    Save
                  </button>
                </div>
              </form>
            </div>

            <div class="grid max-w-7xl grid-cols-1 gap-x-8 gap-y-10 px-4 py-16 sm:px-6 md:grid-cols-3 lg:px-8">
              <div>
                <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">
                  Change password
                </h2>
                <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                  Update your password associated with your account.
                </p>
              </div>

              <form class="md:col-span-2">
                <div class="grid grid-cols-1 gap-x-6 gap-y-8 sm:max-w-xl sm:grid-cols-6">
                  <div class="col-span-full">
                    <label
                      for="current-password"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Current password
                    </label>
                    <div class="mt-2">
                      <input
                        id="current-password"
                        name="current_password"
                        type="password"
                        autocomplete="current-password"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>

                  <div class="col-span-full">
                    <label
                      for="new-password"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      New password
                    </label>
                    <div class="mt-2">
                      <input
                        id="new-password"
                        name="new_password"
                        type="password"
                        autocomplete="new-password"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>

                  <div class="col-span-full">
                    <label
                      for="confirm-password"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Confirm password
                    </label>
                    <div class="mt-2">
                      <input
                        id="confirm-password"
                        name="confirm_password"
                        type="password"
                        autocomplete="new-password"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                <div class="mt-8 flex">
                  <button
                    type="submit"
                    class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
                  >
                    Save
                  </button>
                </div>
              </form>
            </div>

            <div class="grid max-w-7xl grid-cols-1 gap-x-8 gap-y-10 px-4 py-16 sm:px-6 md:grid-cols-3 lg:px-8">
              <div>
                <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">
                  Log out other sessions
                </h2>
                <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                  Please enter your password to confirm you would like to log out of your other
                  sessions across all of your devices.
                </p>
              </div>

              <form class="md:col-span-2">
                <div class="grid grid-cols-1 gap-x-6 gap-y-8 sm:max-w-xl sm:grid-cols-6">
                  <div class="col-span-full">
                    <label
                      for="logout-password"
                      class="block text-sm/6 font-medium text-gray-900 dark:text-white"
                    >
                      Your password
                    </label>
                    <div class="mt-2">
                      <input
                        id="logout-password"
                        name="password"
                        type="password"
                        autocomplete="current-password"
                        class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                <div class="mt-8 flex">
                  <button
                    type="submit"
                    class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
                  >
                    Log out other sessions
                  </button>
                </div>
              </form>
            </div>

            <div class="grid max-w-7xl grid-cols-1 gap-x-8 gap-y-10 px-4 py-16 sm:px-6 md:grid-cols-3 lg:px-8">
              <div>
                <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">
                  Delete account
                </h2>
                <p class="mt-1 text-sm/6 text-gray-500 dark:text-gray-400">
                  No longer want to use our service? You can delete your account here. This action
                  is not reversible. All information related to this account will be deleted
                  permanently.
                </p>
              </div>

              <form class="flex items-start md:col-span-2">
                <button
                  type="submit"
                  class="rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-red-500 dark:bg-red-500 dark:shadow-none dark:hover:bg-red-400"
                >
                  Yes, delete my account
                </button>
              </form>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export function SettingsScreensDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Settings screen — Sidebar layout
        </h3>
        <div class="page-preview rounded-xl border border-surface-border overflow-auto">
          <SettingsScreensSidebar />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Settings screen — Stacked layout (Account)
        </h3>
        <div class="page-preview rounded-xl border border-surface-border overflow-auto">
          <SettingsScreensStacked />
        </div>
      </div>
    </div>
  );
}
