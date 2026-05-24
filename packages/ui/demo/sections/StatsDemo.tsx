import { ArrowUp, ArrowDown, Users, MailOpen, MousePointer } from 'lucide-preact';
import { classNames } from '../../src/internal/class-names.ts';

const stats1 = [
  { name: 'Revenue', value: '$405,091.00', change: '+4.75%', changeType: 'positive' },
  { name: 'Overdue invoices', value: '$12,787.00', change: '+54.02%', changeType: 'negative' },
  { name: 'Outstanding invoices', value: '$245,988.00', change: '-1.39%', changeType: 'positive' },
  { name: 'Expenses', value: '$30,156.00', change: '+10.18%', changeType: 'negative' },
];

const stats2 = [
  { name: 'Number of deploys', value: '405' },
  { name: 'Average deploy time', value: '3.65', unit: 'mins' },
  { name: 'Number of servers', value: '3' },
  { name: 'Success rate', value: '98.5%' },
];

const stats3 = [
  { name: 'Total Subscribers', stat: '71,897' },
  { name: 'Avg. Open Rate', stat: '58.16%' },
  { name: 'Avg. Click Rate', stat: '24.57%' },
];

function WithTrending() {
  return (
    <dl class="mx-auto grid grid-cols-1 gap-px bg-surface-2/5 sm:grid-cols-2 lg:grid-cols-4 dark:bg-white/10">
      {stats1.map((stat) => (
        <div
          key={stat.name}
          class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 bg-surface-0 px-4 py-10 sm:px-6 xl:px-8 dark:bg-surface-2"
        >
          <dt class="text-sm/6 font-medium text-text-secondary dark:text-text-tertiary">
            {stat.name}
          </dt>
          <dd
            class={classNames(
              stat.changeType === 'negative'
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-text-secondary dark:text-text-tertiary',
              'text-xs font-medium'
            )}
          >
            {stat.change}
          </dd>
          <dd class="w-full flex-none text-3xl/10 font-medium tracking-tight text-text-primary dark:text-white">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Simple() {
  return (
    <div class="bg-surface-0 dark:bg-surface-2">
      <div class="mx-auto max-w-7xl">
        <div class="grid grid-cols-1 gap-px bg-surface-2/5 sm:grid-cols-2 lg:grid-cols-4 dark:bg-white/10">
          {stats2.map((stat) => (
            <div key={stat.name} class="bg-surface-0 px-4 py-6 sm:px-6 lg:px-8 dark:bg-surface-2">
              <p class="text-sm/6 font-medium text-text-secondary dark:text-text-tertiary">
                {stat.name}
              </p>
              <p class="mt-2 flex items-baseline gap-x-2">
                <span class="text-4xl font-semibold tracking-tight text-text-primary dark:text-white">
                  {stat.value}
                </span>
                {stat.unit ? (
                  <span class="text-sm text-text-secondary dark:text-text-tertiary">
                    {stat.unit}
                  </span>
                ) : null}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SimpleInCards() {
  return (
    <div>
      <h3 class="text-base font-semibold text-text-primary dark:text-white">Last 30 days</h3>
      <dl class="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
        {stats3.map((item) => (
          <div
            key={item.name}
            class="overflow-hidden rounded-lg bg-white px-4 py-5 shadow-sm sm:p-6 dark:bg-surface-2/75 dark:inset-ring dark:inset-ring-white/10"
          >
            <dt class="truncate text-sm font-medium text-text-secondary dark:text-text-tertiary">
              {item.name}
            </dt>
            <dd class="mt-1 text-3xl font-semibold tracking-tight text-text-primary dark:text-white">
              {item.stat}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const statsWithIcons = [
  {
    id: 1,
    name: 'Total Subscribers',
    stat: '71,897',
    icon: Users,
    change: '122',
    changeType: 'increase',
  },
  {
    id: 2,
    name: 'Avg. Open Rate',
    stat: '58.16%',
    icon: MailOpen,
    change: '5.4%',
    changeType: 'increase',
  },
  {
    id: 3,
    name: 'Avg. Click Rate',
    stat: '24.57%',
    icon: MousePointer,
    change: '3.2%',
    changeType: 'decrease',
  },
];

function WithBrandIcon() {
  return (
    <div>
      <h3 class="text-base font-semibold text-text-primary dark:text-white">Last 30 days</h3>

      <dl class="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {statsWithIcons.map((item) => (
          <div
            key={item.id}
            class="relative overflow-hidden rounded-lg bg-white px-4 pt-5 pb-12 shadow-sm sm:px-6 sm:pt-6 dark:bg-surface-2/75 dark:inset-ring dark:inset-ring-white/10"
          >
            <dt>
              <div class="absolute rounded-md bg-accent-500 p-3">
                <item.icon aria-hidden="true" class="size-6 text-white" />
              </div>
              <p class="ml-16 truncate text-sm font-medium text-text-secondary dark:text-text-tertiary">
                {item.name}
              </p>
            </dt>
            <dd class="ml-16 flex items-baseline pb-6 sm:pb-7">
              <p class="text-2xl font-semibold text-text-primary dark:text-white">{item.stat}</p>
              <p
                class={classNames(
                  item.changeType === 'increase'
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400',
                  'ml-2 flex items-baseline text-sm font-semibold'
                )}
              >
                {item.changeType === 'increase' ? (
                  <ArrowUp
                    aria-hidden="true"
                    class="size-5 shrink-0 self-center text-green-500 dark:text-green-400"
                  />
                ) : (
                  <ArrowDown
                    aria-hidden="true"
                    class="size-5 shrink-0 self-center text-red-500 dark:text-red-400"
                  />
                )}

                <span class="sr-only">
                  {' '}
                  {item.changeType === 'increase' ? 'Increased' : 'Decreased'} by{' '}
                </span>
                {item.change}
              </p>
              <div class="absolute inset-x-0 bottom-0 bg-surface-0 px-4 py-4 sm:px-6 dark:bg-surface-2/20">
                <div class="text-sm">
                  <a
                    href="#"
                    class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                  >
                    View all<span class="sr-only"> {item.name} stats</span>
                  </a>
                </div>
              </div>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const statsWithSharedBorders = [
  {
    name: 'Total Subscribers',
    stat: '71,897',
    previousStat: '70,946',
    change: '12%',
    changeType: 'increase',
  },
  {
    name: 'Avg. Open Rate',
    stat: '58.16%',
    previousStat: '56.14%',
    change: '2.02%',
    changeType: 'increase',
  },
  {
    name: 'Avg. Click Rate',
    stat: '24.57%',
    previousStat: '28.62%',
    change: '4.05%',
    changeType: 'decrease',
  },
];

function WithSharedBorders() {
  return (
    <div>
      <h3 class="text-base font-semibold text-text-primary dark:text-white">Last 30 days</h3>
      <dl class="mt-5 grid grid-cols-1 divide-surface-border overflow-hidden rounded-lg bg-surface-0 shadow-sm md:grid-cols-3 md:divide-x md:divide-y-0 dark:divide-white/10 dark:bg-surface-2/75 dark:shadow-none dark:inset-ring dark:inset-ring-white/10">
        {statsWithSharedBorders.map((item) => (
          <div key={item.name} class="px-4 py-5 sm:p-6">
            <dt class="text-base font-normal text-text-primary dark:text-text-tertiary">
              {item.name}
            </dt>
            <dd class="mt-1 flex items-baseline justify-between md:block lg:flex">
              <div class="flex items-baseline text-2xl font-semibold text-accent-500 dark:text-accent-400">
                {item.stat}
                <span class="ml-2 text-sm font-medium text-text-secondary dark:text-text-tertiary">
                  from {item.previousStat}
                </span>
              </div>

              <div
                class={classNames(
                  item.changeType === 'increase'
                    ? 'bg-green-100 text-green-800 dark:bg-green-400/10 dark:text-green-400'
                    : 'bg-red-100 text-red-800 dark:bg-red-400/10 dark:text-red-400',
                  'inline-flex items-baseline rounded-full px-2.5 py-0.5 text-sm font-medium md:mt-2 lg:mt-0'
                )}
              >
                {item.changeType === 'increase' ? (
                  <ArrowUp
                    aria-hidden="true"
                    class="mr-0.5 -ml-1 size-5 shrink-0 self-center text-green-500 dark:text-green-400"
                  />
                ) : (
                  <ArrowDown
                    aria-hidden="true"
                    class="mr-0.5 -ml-1 size-5 shrink-0 self-center text-red-500 dark:text-red-400"
                  />
                )}

                <span class="sr-only">
                  {' '}
                  {item.changeType === 'increase' ? 'Increased' : 'Decreased'} by{' '}
                </span>
                {item.change}
              </div>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function StatsDemo() {
  return (
    <div class="space-y-12">
      <section>
        <h2 class="text-lg font-semibold text-text-primary dark:text-white mb-4">With Trending</h2>
        <WithTrending />
      </section>
      <section>
        <h2 class="text-lg font-semibold text-text-primary dark:text-white mb-4">Simple</h2>
        <Simple />
      </section>
      <section>
        <h2 class="text-lg font-semibold text-text-primary dark:text-white mb-4">
          Simple in Cards
        </h2>
        <SimpleInCards />
      </section>
      <section>
        <h2 class="text-lg font-semibold text-text-primary dark:text-white mb-4">
          With Brand Icon
        </h2>
        <WithBrandIcon />
      </section>
      <section>
        <h2 class="text-lg font-semibold text-text-primary dark:text-white mb-4">
          With Shared Borders
        </h2>
        <WithSharedBorders />
      </section>
    </div>
  );
}
