import { ChevronDown, User, Building, Users, CreditCard } from 'lucide-preact';
import { classNames } from '../../src/internal/class-names.ts';

const tabsWithUnderline = [
  { name: 'My Account', href: '#', current: false },
  { name: 'Company', href: '#', current: false },
  { name: 'Team Members', href: '#', current: true },
  { name: 'Billing', href: '#', current: false },
];

const tabsWithIcons = [
  { name: 'My Account', href: '#', icon: User, current: false },
  { name: 'Company', href: '#', icon: Building, current: false },
  { name: 'Team Members', href: '#', icon: Users, current: true },
  { name: 'Billing', href: '#', icon: CreditCard, current: false },
];

const tabsPills = [
  { name: 'My Account', href: '#', current: false },
  { name: 'Company', href: '#', current: false },
  { name: 'Team Members', href: '#', current: true },
  { name: 'Billing', href: '#', current: false },
];

const tabsWithBadges = [
  { name: 'Applied', href: '#', count: '52', current: false },
  { name: 'Phone Screening', href: '#', count: '6', current: false },
  { name: 'Interview', href: '#', count: '4', current: true },
  { name: 'Offer', href: '#', current: false },
  { name: 'Disqualified', href: '#', current: false },
];

export function TabsWithUnderline() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsWithUnderline.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsWithUnderline.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <nav aria-label="Tabs" class="flex space-x-4">
          {tabsWithUnderline.map((tab) => (
            <a
              key={tab.name}
              href={tab.href}
              aria-current={tab.current ? 'page' : undefined}
              class={classNames(
                tab.current
                  ? 'bg-surface-1 text-text-primary dark:bg-white/10 dark:text-text-tertiary'
                  : 'text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-text-tertiary',
                'rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {tab.name}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function TabsWithUnderlineAndIcons() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsWithIcons.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsWithIcons.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <div class="border-b border-surface-border dark:border-white/10">
          <nav aria-label="Tabs" class="-mb-px flex space-x-8">
            {tabsWithIcons.map((tab) => (
              <a
                key={tab.name}
                href={tab.href}
                aria-current={tab.current ? 'page' : undefined}
                class={classNames(
                  tab.current
                    ? 'border-accent-500 text-accent-400 dark:border-accent-400 dark:text-accent-400'
                    : 'border-transparent text-text-tertiary hover:border-surface-border hover:text-text-secondary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-tertiary',
                  'border-b-2 px-1 py-4 text-sm font-medium whitespace-nowrap'
                )}
              >
                <tab.icon
                  aria-hidden="true"
                  class={classNames(
                    tab.current
                      ? 'text-accent-500 dark:text-accent-400'
                      : 'text-text-tertiary group-hover:text-text-secondary dark:text-text-tertiary dark:group-hover:text-text-tertiary',
                    'mr-2 -ml-0.5 size-5'
                  )}
                />
                <span>{tab.name}</span>
              </a>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function TabsInPills() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsPills.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsPills.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <nav aria-label="Tabs" class="flex space-x-4">
          {tabsPills.map((tab) => (
            <a
              key={tab.name}
              href={tab.href}
              aria-current={tab.current ? 'page' : undefined}
              class={classNames(
                tab.current
                  ? 'bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300'
                  : 'text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-text-tertiary',
                'rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {tab.name}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function TabsInPillsOnGray() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsPills.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-2 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-surface-2/50 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsPills.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <nav aria-label="Tabs" class="flex space-x-4">
          {tabsPills.map((tab) => (
            <a
              key={tab.name}
              href={tab.href}
              aria-current={tab.current ? 'page' : undefined}
              class={classNames(
                tab.current
                  ? 'bg-surface-0 text-text-primary dark:bg-white/10 dark:text-white'
                  : 'text-text-secondary hover:text-text-primary dark:text-text-tertiary dark:hover:text-white',
                'rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {tab.name}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function TabsInPillsWithBrandColor() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsPills.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsPills.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <nav aria-label="Tabs" class="flex space-x-4">
          {tabsPills.map((tab) => (
            <a
              key={tab.name}
              href={tab.href}
              aria-current={tab.current ? 'page' : undefined}
              class={classNames(
                tab.current
                  ? 'bg-surface-2 text-text-primary dark:bg-white/10 dark:text-white'
                  : 'text-text-secondary hover:text-text-primary dark:text-text-tertiary dark:hover:text-white',
                'rounded-md px-3 py-2 text-sm font-medium'
              )}
            >
              {tab.name}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function FullWidthTabsWithUnderline() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsWithBadges.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsWithBadges.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <div class="border-b border-surface-border dark:border-white/10">
          <nav aria-label="Tabs" class="-mb-px flex space-x-8">
            {tabsWithBadges.map((tab) => (
              <a
                key={tab.name}
                href="#"
                aria-current={tab.current ? 'page' : undefined}
                class={classNames(
                  tab.current
                    ? 'border-accent-500 text-accent-400 dark:border-accent-400 dark:text-accent-400'
                    : 'border-transparent text-text-tertiary hover:border-surface-border hover:text-text-secondary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-white',
                  'flex border-b-2 px-1 py-4 text-sm font-medium whitespace-nowrap'
                )}
              >
                {tab.name}
                {tab.count ? (
                  <span
                    class={classNames(
                      tab.current
                        ? 'bg-accent-100 text-accent-600 dark:bg-accent-500/20 dark:text-accent-400'
                        : 'bg-surface-2 text-text-primary dark:bg-white/10 dark:text-text-secondary',
                      'ml-3 hidden rounded-full px-2.5 py-0.5 text-xs font-medium md:inline-block'
                    )}
                  >
                    {tab.count}
                  </span>
                ) : null}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function BarWithUnderline() {
  return (
    <div class="bg-surface-0 px-4 py-6 sm:px-6 lg:px-8 dark:bg-surface-2">
      <div class="mx-auto max-w-7xl">
        <div class="grid grid-cols-1 sm:hidden">
          <select
            defaultValue={tabsWithUnderline.find((tab) => tab.current)?.name ?? ''}
            aria-label="Select a tab"
            class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
          >
            {tabsWithUnderline.map((tab) => (
              <option key={tab.name}>{tab.name}</option>
            ))}
          </select>
          <ChevronDown
            aria-hidden="true"
            class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
          />
        </div>
        <div class="hidden sm:block">
          <nav class="flex border-b border-surface-border py-4 dark:border-white/10">
            <ul
              role="list"
              class="flex min-w-full flex-none gap-x-8 px-2 text-sm/6 font-semibold text-text-tertiary"
            >
              {tabsWithUnderline.map((tab) => (
                <li key={tab.name}>
                  <a
                    href={tab.href}
                    class={
                      tab.current
                        ? 'text-accent-400 dark:text-accent-400'
                        : 'hover:text-text-secondary dark:hover:text-white'
                    }
                  >
                    {tab.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </div>
  );
}

export function TabsWithUnderlineAndBadges() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsWithUnderline.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsWithUnderline.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <nav
          aria-label="Tabs"
          class="isolate flex divide-x divide-surface-border rounded-lg bg-surface-0 shadow-sm dark:divide-white/10 dark:bg-surface-2/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10"
        >
          {tabsWithUnderline.map((tab, tabIdx) => (
            <a
              key={tab.name}
              href={tab.href}
              aria-current={tab.current ? 'page' : undefined}
              class={classNames(
                tab.current
                  ? 'text-text-primary dark:text-white'
                  : 'text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white',
                tabIdx === 0 ? 'rounded-l-lg' : '',
                tabIdx === tabsWithUnderline.length - 1 ? 'rounded-r-lg' : '',
                'group relative min-w-0 flex-1 overflow-hidden px-4 py-4 text-center text-sm font-medium hover:bg-surface-0 focus:z-10 dark:hover:bg-white/5'
              )}
            >
              <span>{tab.name}</span>
              <span
                aria-hidden="true"
                class={classNames(
                  tab.current ? 'bg-accent-500 dark:bg-accent-400' : 'bg-transparent',
                  'absolute inset-x-0 bottom-0 h-0.5'
                )}
              />
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function SimpleTabs() {
  return (
    <div>
      <div class="grid grid-cols-1 sm:hidden">
        <select
          defaultValue={tabsWithUnderline.find((tab) => tab.current)?.name ?? ''}
          aria-label="Select a tab"
          class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-0 py-2 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 dark:bg-white/5 dark:text-text-tertiary dark:outline-white/10 dark:*:bg-surface-2 dark:focus:outline-accent-500"
        >
          {tabsWithUnderline.map((tab) => (
            <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end fill-text-tertiary dark:fill-text-tertiary"
        />
      </div>
      <div class="hidden sm:block">
        <div class="border-b border-surface-border dark:border-white/10">
          <nav aria-label="Tabs" class="-mb-px flex">
            {tabsWithUnderline.map((tab) => (
              <a
                key={tab.name}
                href={tab.href}
                aria-current={tab.current ? 'page' : undefined}
                class={classNames(
                  tab.current
                    ? 'border-accent-500 text-accent-400 dark:border-accent-400 dark:text-accent-400'
                    : 'border-transparent text-text-tertiary hover:border-surface-border hover:text-text-secondary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-tertiary',
                  'w-1/4 border-b-2 px-1 py-4 text-center text-sm font-medium'
                )}
              >
                {tab.name}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function TabsDemo() {
  return (
    <div class="flex flex-col gap-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Tabs with underline</h3>
        <TabsWithUnderline />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Tabs with underline and icons</h3>
        <TabsWithUnderlineAndIcons />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Tabs in pills</h3>
        <TabsInPills />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Tabs in pills on gray</h3>
        <div class="bg-surface-2 p-4 dark:bg-surface-2/50">
          <TabsInPillsOnGray />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Tabs in pills with brand color</h3>
        <TabsInPillsWithBrandColor />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Full width tabs with underline</h3>
        <FullWidthTabsWithUnderline />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Bar with underline</h3>
        <BarWithUnderline />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Tabs with underline and badges</h3>
        <TabsWithUnderlineAndBadges />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple</h3>
        <SimpleTabs />
      </div>
    </div>
  );
}
