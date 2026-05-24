import {
  ChevronRight,
  Home,
  Users,
  Folder,
  Calendar,
  Copy,
  PieChart,
  Settings,
  Cog,
} from 'lucide-preact';
import { Disclosure, DisclosureButton, DisclosurePanel } from '../../src/mod.ts';
import { classNames } from '../../src/internal/class-names.ts';

const navigationWithIcons = [
  { name: 'Dashboard', href: '#', icon: Home, count: '5', current: true },
  { name: 'Team', href: '#', icon: Users, current: false },
  { name: 'Projects', href: '#', icon: Folder, count: '12', current: false },
  { name: 'Calendar', href: '#', icon: Calendar, count: '20+', current: false },
  { name: 'Documents', href: '#', icon: Copy, current: false },
  { name: 'Reports', href: '#', icon: PieChart, current: false },
];

const teams = [
  { id: 1, name: 'Heroicons', href: '#', initial: 'H', current: false },
  { id: 2, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  { id: 3, name: 'Workcation', href: '#', initial: 'W', current: false },
];

const expandableNavigation = [
  { name: 'Dashboard', href: '#', current: true },
  {
    name: 'Teams',
    current: false,
    children: [
      { name: 'Engineering', href: '#', current: false },
      { name: 'Human Resources', href: '#', current: false },
      { name: 'Customer Success', href: '#', current: false },
    ],
  },
  {
    name: 'Projects',
    current: false,
    children: [
      { name: 'GraphQL API', href: '#', current: false },
      { name: 'iOS App', href: '#', current: false },
      { name: 'Android App', href: '#', current: false },
      { name: 'New Customer Portal', href: '#', current: false },
    ],
  },
  { name: 'Calendar', href: '#', current: false },
  { name: 'Documents', href: '#', current: false },
  { name: 'Reports', href: '#', current: false },
];

export function LightSidebarNavigation() {
  return (
    <div class="relative flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-0 px-6 dark:border-white/10 dark:bg-surface-2 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
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
              {navigationWithIcons.map((item) => (
                <li key={item.name}>
                  <a
                    href={item.href}
                    class={classNames(
                      item.current
                        ? 'bg-surface-1 text-accent-500 dark:bg-white/5 dark:text-white'
                        : 'text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                      'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                    )}
                  >
                    <item.icon
                      aria-hidden="true"
                      class={classNames(
                        item.current
                          ? 'text-accent-500 dark:text-white'
                          : 'text-text-tertiary group-hover:text-accent-500 dark:text-text-tertiary dark:group-hover:text-white',
                        'size-6 shrink-0'
                      )}
                    />
                    {item.name}
                    {item.count ? (
                      <span
                        aria-hidden="true"
                        class="ml-auto w-9 min-w-max rounded-full bg-white px-2.5 py-0.5 text-center text-xs/5 font-medium whitespace-nowrap text-text-secondary outline-1 -outline-offset-1 outline-surface-border dark:bg-surface-2 dark:text-white dark:outline-white/15"
                      >
                        {item.count}
                      </span>
                    ) : null}
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
                        ? 'bg-surface-1 text-accent-500 dark:bg-white/5 dark:text-white'
                        : 'text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                      'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                    )}
                  >
                    <span
                      class={classNames(
                        team.current
                          ? 'border-accent-500 text-accent-500 dark:border-white/10 dark:text-white'
                          : 'border-surface-border text-text-tertiary group-hover:border-accent-500 group-hover:text-accent-500 dark:border-white/15 dark:group-hover:border-white/20 dark:group-hover:text-white',
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
                class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
              <span class="sr-only">Your profile</span>
              <span aria-hidden="true">Tom Cook</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function DarkSidebarNavigation() {
  return (
    <div class="relative flex grow flex-col gap-y-5 overflow-y-auto bg-surface-2 px-6 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-r dark:before:border-white/10 dark:before:bg-black/10">
      <div class="relative flex h-16 shrink-0 items-center">
        <img
          alt="Your Company"
          src="https://tailwindcss.com/plus-assets/img/logos/mark.svg?color=indigo&shade=500"
          class="h-8 w-auto"
        />
      </div>
      <nav class="relative flex flex-1 flex-col">
        <ul role="list" class="flex flex-1 flex-col gap-y-7">
          <li>
            <ul role="list" class="-mx-2 space-y-1">
              {navigationWithIcons.map((item) => (
                <li key={item.name}>
                  <a
                    href={item.href}
                    class={classNames(
                      item.current
                        ? 'bg-white/5 text-white'
                        : 'text-text-tertiary hover:bg-white/5 hover:text-white',
                      'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                    )}
                  >
                    <item.icon aria-hidden="true" class="size-6 shrink-0" />
                    {item.name}
                    {item.count ? (
                      <span
                        aria-hidden="true"
                        class="ml-auto w-9 min-w-max rounded-full bg-surface-2 px-2.5 py-0.5 text-center text-xs/5 font-medium whitespace-nowrap text-white outline-1 -outline-offset-1 outline-white/15"
                      >
                        {item.count}
                      </span>
                    ) : null}
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
                        ? 'bg-white/5 text-white'
                        : 'text-text-tertiary hover:bg-white/5 hover:text-white',
                      'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                    )}
                  >
                    <span class="flex size-6 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-[0.625rem] font-medium text-text-tertiary group-hover:border-white/20 group-hover:text-white">
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
                class="size-8 rounded-full bg-surface-2 outline -outline-offset-1 outline-white/10"
              />
              <span class="sr-only">Your profile</span>
              <span aria-hidden="true">Tom Cook</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function ExpandableSectionsSidebarNavigation() {
  return (
    <div class="relative flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-0 px-6 dark:border-white/10 dark:bg-surface-2 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
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
              {expandableNavigation.map((item) => (
                <li key={item.name}>
                  {!item.children ? (
                    <a
                      href={item.href}
                      class={classNames(
                        item.current
                          ? 'bg-surface-1 dark:bg-white/5'
                          : 'hover:bg-surface-1 dark:hover:bg-white/5',
                        'block rounded-md py-2 pr-2 pl-10 text-sm/6 font-semibold text-text-secondary dark:text-text-tertiary'
                      )}
                    >
                      {item.name}
                    </a>
                  ) : (
                    <Disclosure as="div">
                      <DisclosureButton
                        class={classNames(
                          item.current
                            ? 'bg-surface-1 dark:bg-white/5'
                            : 'hover:bg-surface-1 dark:hover:bg-white/5',
                          'group flex w-full items-center gap-x-3 rounded-md p-2 text-left text-sm/6 font-semibold text-text-secondary dark:text-text-tertiary'
                        )}
                      >
                        <ChevronRight
                          aria-hidden="true"
                          class="size-5 shrink-0 text-text-tertiary transition-transform group-data-open:rotate-90 group-data-open:text-text-secondary dark:text-text-tertiary dark:group-data-open:text-text-tertiary"
                        />
                        {item.name}
                      </DisclosureButton>
                      <DisclosurePanel as="ul" class="mt-1 px-2">
                        {item.children.map((subItem) => (
                          <li key={subItem.name}>
                            <DisclosureButton
                              as="a"
                              href={subItem.href}
                              class={classNames(
                                subItem.current
                                  ? 'bg-surface-1 dark:bg-white/5'
                                  : 'hover:bg-surface-1 dark:hover:bg-white/5',
                                'block rounded-md py-2 pr-2 pl-9 text-sm/6 text-text-secondary dark:text-text-tertiary'
                              )}
                            >
                              {subItem.name}
                            </DisclosureButton>
                          </li>
                        ))}
                      </DisclosurePanel>
                    </Disclosure>
                  )}
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
                class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
              <span class="sr-only">Your profile</span>
              <span aria-hidden="true">Tom Cook</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function ExpandableSectionsWithIconsSidebarNavigation() {
  const expandableNavWithIcons = [
    { name: 'Dashboard', href: '#', icon: Home, current: true },
    {
      name: 'Teams',
      icon: Users,
      current: false,
      children: [
        { name: 'Engineering', href: '#' },
        { name: 'Human Resources', href: '#' },
        { name: 'Customer Success', href: '#' },
      ],
    },
    {
      name: 'Projects',
      icon: Folder,
      current: false,
      children: [
        { name: 'GraphQL API', href: '#' },
        { name: 'iOS App', href: '#' },
        { name: 'Android App', href: '#' },
        { name: 'New Customer Portal', href: '#' },
      ],
    },
    { name: 'Calendar', href: '#', icon: Calendar, current: false },
    { name: 'Documents', href: '#', icon: Copy, current: false },
    { name: 'Reports', href: '#', icon: PieChart, current: false },
  ];

  return (
    <div class="relative flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-0 px-6 dark:border-white/10 dark:bg-surface-2 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
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
              {expandableNavWithIcons.map((item) => (
                <li key={item.name}>
                  {!item.children ? (
                    <a
                      href={item.href}
                      class={classNames(
                        item.current
                          ? 'bg-surface-1 dark:bg-white/5 dark:text-white'
                          : 'hover:bg-surface-1 dark:hover:bg-white/5 dark:hover:text-white',
                        'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold text-text-secondary dark:text-text-tertiary'
                      )}
                    >
                      <item.icon
                        aria-hidden="true"
                        class={classNames(
                          item.current
                            ? 'text-accent-500 dark:text-white'
                            : 'text-text-tertiary group-hover:text-accent-500 dark:text-text-tertiary dark:group-hover:text-white',
                          'size-6 shrink-0'
                        )}
                      />
                      {item.name}
                    </a>
                  ) : (
                    <Disclosure as="div">
                      <DisclosureButton
                        class={classNames(
                          item.current
                            ? 'bg-surface-1 dark:bg-white/5 dark:text-white'
                            : 'hover:bg-surface-1 dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex w-full items-center gap-x-3 rounded-md p-2 text-left text-sm/6 font-semibold text-text-secondary dark:text-text-tertiary'
                        )}
                      >
                        <item.icon
                          aria-hidden="true"
                          class={classNames(
                            item.current
                              ? 'text-accent-500 dark:text-white'
                              : 'text-text-tertiary group-hover:text-accent-500 dark:text-text-tertiary dark:group-hover:text-white',
                            'size-6 shrink-0'
                          )}
                        />
                        {item.name}
                        <ChevronRight
                          aria-hidden="true"
                          class="ml-auto size-5 shrink-0 text-text-tertiary transition-transform group-data-open:rotate-90 group-data-open:text-text-secondary dark:text-text-tertiary dark:group-data-open:text-text-tertiary"
                        />
                      </DisclosureButton>
                      <DisclosurePanel as="ul" class="mt-1 px-2">
                        {item.children.map((subItem) => (
                          <li key={subItem.name}>
                            <DisclosureButton
                              as="a"
                              href={subItem.href}
                              class={classNames(
                                'hover:bg-surface-1 dark:hover:bg-white/5',
                                'block rounded-md py-2 pr-2 pl-9 text-sm/6 text-text-secondary dark:text-text-tertiary'
                              )}
                            >
                              {subItem.name}
                            </DisclosureButton>
                          </li>
                        ))}
                      </DisclosurePanel>
                    </Disclosure>
                  )}
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
                class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
              <span class="sr-only">Your profile</span>
              <span aria-hidden="true">Tom Cook</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function WithSecondaryNavigationSidebarNavigation() {
  const navigation = [
    { name: 'Dashboard', href: '#', icon: Home, current: true },
    { name: 'Team', href: '#', icon: Users, current: false },
    { name: 'Projects', href: '#', icon: Folder, current: false },
    { name: 'Calendar', href: '#', icon: Calendar, current: false },
  ];

  return (
    <div class="relative flex grow flex-col gap-y-5 overflow-y-auto border-r border-surface-border bg-surface-0 px-6 dark:border-white/10 dark:bg-surface-2 dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:bg-black/10">
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
                        ? 'bg-surface-1 text-accent-500 dark:bg-white/5 dark:text-white'
                        : 'text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                      'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                    )}
                  >
                    <item.icon
                      aria-hidden="true"
                      class={classNames(
                        item.current
                          ? 'text-accent-500 dark:text-white'
                          : 'text-text-tertiary group-hover:text-accent-500 dark:text-text-tertiary dark:group-hover:text-white',
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
                        ? 'bg-surface-1 text-accent-500 dark:bg-white/5 dark:text-white'
                        : 'text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                      'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                    )}
                  >
                    <span
                      class={classNames(
                        team.current
                          ? 'border-accent-500 text-accent-500 dark:border-white/10 dark:text-white'
                          : 'border-surface-border text-text-tertiary group-hover:border-accent-500 group-hover:text-accent-500 dark:border-white/15 dark:group-hover:border-white/20 dark:group-hover:text-white',
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
            <div class="space-y-1 border-t border-surface-border pt-4 dark:border-white/10">
              <ul role="list" class="-mx-2 space-y-1">
                <li>
                  <a
                    href="#"
                    class="group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white"
                  >
                    <Settings
                      aria-hidden="true"
                      class="size-6 shrink-0 text-text-tertiary group-hover:text-accent-500 dark:text-text-tertiary dark:group-hover:text-white"
                    />
                    Settings
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    class="group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white"
                  >
                    <Cog
                      aria-hidden="true"
                      class="size-6 shrink-0 text-text-tertiary group-hover:text-accent-500 dark:text-text-tertiary dark:group-hover:text-white"
                    />
                    Integrations
                  </a>
                </li>
              </ul>
              <ul role="list" class="mt-4 space-y-1">
                <li>
                  <a
                    href="#"
                    class="block rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white"
                  >
                    Support
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    class="block rounded-md px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-1 hover:text-text-primary dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white"
                  >
                    License
                  </a>
                </li>
              </ul>
            </div>
          </li>
          <li class="-mx-6">
            <a
              href="#"
              class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-text-primary hover:bg-surface-1 dark:text-white dark:hover:bg-white/5"
            >
              <img
                alt=""
                src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                class="size-8 rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
              <span class="sr-only">Your profile</span>
              <span aria-hidden="true">Tom Cook</span>
            </a>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function SidebarNavigationDemo() {
  return (
    <div class="flex flex-col gap-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Light</h3>
        <div class="h-96 w-64 rounded-lg border border-surface-border">
          <LightSidebarNavigation />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Dark</h3>
        <div class="h-96 w-64 rounded-lg border border-surface-border dark">
          <DarkSidebarNavigation />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With expandable sections</h3>
        <div class="h-96 w-64 rounded-lg border border-surface-border">
          <ExpandableSectionsSidebarNavigation />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          With expandable sections and icons
        </h3>
        <div class="h-96 w-64 rounded-lg border border-surface-border">
          <ExpandableSectionsWithIconsSidebarNavigation />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With secondary navigation</h3>
        <div class="h-96 w-64 rounded-lg border border-surface-border">
          <WithSecondaryNavigationSidebarNavigation />
        </div>
      </div>
    </div>
  );
}
