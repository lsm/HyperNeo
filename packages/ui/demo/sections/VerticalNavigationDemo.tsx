import { Home, Users, Folder, Calendar, Copy, PieChart } from 'lucide-preact';
import { classNames } from '../../src/internal/class-names.ts';

const simpleNavigation = [
  { name: 'Dashboard', href: '#', current: true },
  { name: 'Team', href: '#', current: false },
  { name: 'Projects', href: '#', current: false },
  { name: 'Calendar', href: '#', current: false },
  { name: 'Documents', href: '#', current: false },
  { name: 'Reports', href: '#', current: false },
];

const badgeNavigation = [
  { name: 'Dashboard', href: '#', count: '5', current: true },
  { name: 'Team', href: '#', current: false },
  { name: 'Projects', href: '#', count: '12', current: false },
  { name: 'Calendar', href: '#', count: '20+', current: false },
  { name: 'Documents', href: '#', current: false },
  { name: 'Reports', href: '#', current: false },
];

const navigationWithIcons = [
  { name: 'Dashboard', href: '#', icon: Home, current: true },
  { name: 'Team', href: '#', icon: Users, current: false },
  { name: 'Projects', href: '#', icon: Folder, current: false },
  { name: 'Calendar', href: '#', icon: Calendar, current: false },
  { name: 'Documents', href: '#', icon: Copy, current: false },
  { name: 'Reports', href: '#', icon: PieChart, current: false },
];

const navigationWithIconsAndCounts = [
  { name: 'Dashboard', href: '#', icon: Home, count: '5', current: true },
  { name: 'Team', href: '#', icon: Users, current: false },
  { name: 'Projects', href: '#', icon: Folder, count: '12', current: false },
  { name: 'Calendar', href: '#', icon: Calendar, count: '20+', current: false },
  { name: 'Documents', href: '#', icon: Copy, current: false },
  { name: 'Reports', href: '#', icon: PieChart, current: false },
];

const secondaryNavigation = [
  { name: 'Website redesign', href: '#', initial: 'W', current: false },
  { name: 'GraphQL API', href: '#', initial: 'G', current: false },
  { name: 'Customer migration guides', href: '#', initial: 'C', current: false },
  { name: 'Profit sharing program', href: '#', initial: 'P', current: false },
];

export function SimpleVerticalNavigation() {
  return (
    <nav aria-label="Sidebar" class="flex flex-1 flex-col">
      <ul role="list" class="-mx-2 space-y-1">
        {simpleNavigation.map((item) => (
          <li key={item.name}>
            <a
              href={item.href}
              class={classNames(
                item.current
                  ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                  : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                'group flex gap-x-3 rounded-md p-2 pl-3 text-sm/6 font-semibold'
              )}
            >
              {item.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function BadgeVerticalNavigation() {
  return (
    <nav aria-label="Sidebar" class="flex flex-1 flex-col">
      <ul role="list" class="-mx-2 space-y-1">
        {badgeNavigation.map((item) => (
          <li key={item.name}>
            <a
              href={item.href}
              class={classNames(
                item.current
                  ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                  : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                'group flex gap-x-3 rounded-md p-2 pl-3 text-sm/6 font-semibold'
              )}
            >
              {item.name}
              {item.count ? (
                <span
                  aria-hidden="true"
                  class="ml-auto w-9 min-w-max rounded-full bg-white px-2.5 py-0.5 text-center text-xs/5 font-medium whitespace-nowrap text-text-secondary outline-1 -outline-offset-1 outline-surface-border dark:bg-surface-1 dark:text-text-tertiary dark:outline-white/10"
                >
                  {item.count}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function WithIconsVerticalNavigation() {
  return (
    <nav aria-label="Sidebar" class="flex flex-1 flex-col">
      <ul role="list" class="-mx-2 space-y-1">
        {navigationWithIcons.map((item) => (
          <li key={item.name}>
            <a
              href={item.href}
              class={classNames(
                item.current
                  ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                  : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
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
    </nav>
  );
}

export function WithSecondaryNavigationVerticalNavigation() {
  return (
    <nav aria-label="Sidebar" class="flex flex-1 flex-col">
      <ul role="list" class="flex flex-1 flex-col gap-y-7">
        <li>
          <ul role="list" class="-mx-2 space-y-1">
            {navigationWithIconsAndCounts.map((item) => (
              <li key={item.name}>
                <a
                  href={item.href}
                  class={classNames(
                    item.current
                      ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                      : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
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
                      class="ml-auto w-9 min-w-max rounded-full bg-white px-2.5 py-0.5 text-center text-xs/5 font-medium whitespace-nowrap text-text-secondary outline-1 -outline-offset-1 outline-surface-border dark:bg-surface-2 dark:text-text-tertiary dark:outline-white/10"
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
          <div class="text-xs/6 font-semibold text-text-tertiary">Projects</div>
          <ul role="list" class="-mx-2 mt-2 space-y-1">
            {secondaryNavigation.map((item) => (
              <li key={item.name}>
                <a
                  href={item.href}
                  class={classNames(
                    item.current
                      ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                      : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                    'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                  )}
                >
                  <span
                    class={classNames(
                      item.current
                        ? 'border-accent-500 text-accent-500 dark:border-accent-500 dark:text-white'
                        : 'border-surface-border text-text-tertiary group-hover:border-accent-500 group-hover:text-accent-500 dark:border-white/10 dark:text-text-tertiary dark:group-hover:border-white/20 dark:group-hover:text-white',
                      'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-white text-[0.625rem] font-medium dark:bg-surface-2'
                    )}
                  >
                    {item.initial}
                  </span>
                  <span class="truncate">{item.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </li>
      </ul>
    </nav>
  );
}

export function OnGrayVerticalNavigation() {
  return (
    <nav aria-label="Sidebar" class="flex flex-1 flex-col">
      <ul role="list" class="flex flex-1 flex-col gap-y-7">
        <li>
          <ul role="list" class="-mx-2 space-y-1">
            {navigationWithIconsAndCounts.map((item) => (
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
                      class="ml-auto w-9 min-w-max rounded-full bg-white px-2.5 py-0.5 text-center text-xs/5 font-medium whitespace-nowrap text-text-secondary outline-1 -outline-offset-1 outline-surface-border dark:bg-surface-2 dark:text-text-tertiary dark:outline-white/10"
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
          <div class="text-xs/6 font-semibold text-text-tertiary">Projects</div>
          <ul role="list" class="-mx-2 mt-2 space-y-1">
            {secondaryNavigation.map((item) => (
              <li key={item.name}>
                <a
                  href={item.href}
                  class={classNames(
                    item.current
                      ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                      : 'text-text-secondary hover:bg-surface-1 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                    'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                  )}
                >
                  <span
                    class={classNames(
                      item.current
                        ? 'border-accent-500 text-accent-500 dark:border-accent-500 dark:text-white'
                        : 'border-surface-border text-text-tertiary group-hover:border-accent-500 group-hover:text-accent-500 dark:border-white/10 dark:text-text-tertiary dark:group-hover:border-white/20 dark:group-hover:text-white',
                      'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-white text-[0.625rem] font-medium dark:bg-surface-2/50'
                    )}
                  >
                    {item.initial}
                  </span>
                  <span class="truncate">{item.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </li>
      </ul>
    </nav>
  );
}

export function VerticalNavigationDemo() {
  return (
    <div class="flex flex-col gap-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple</h3>
        <SimpleVerticalNavigation />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With Badges</h3>
        <BadgeVerticalNavigation />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With Icons</h3>
        <WithIconsVerticalNavigation />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With Secondary Navigation</h3>
        <WithSecondaryNavigationVerticalNavigation />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">On Gray</h3>
        <div class="bg-surface-2 p-4 dark:bg-surface-2/50">
          <OnGrayVerticalNavigation />
        </div>
      </div>
    </div>
  );
}
