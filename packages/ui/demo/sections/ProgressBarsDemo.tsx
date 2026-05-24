import { Check } from 'lucide-preact';
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

export function SimpleProgressBars() {
  const steps = [
    { id: 'Step 1', name: 'Job details', href: '#', status: 'complete' },
    { id: 'Step 2', name: 'Application form', href: '#', status: 'current' },
    { id: 'Step 3', name: 'Preview', href: '#', status: 'upcoming' },
  ];

  return (
    <nav aria-label="Progress">
      <ol role="list" class="space-y-4 md:flex md:space-y-0 md:space-x-8">
        {steps.map((step) => (
          <li key={step.name} class="md:flex-1">
            {step.status === 'complete' ? (
              <a
                href={step.href}
                class="group flex flex-col border-l-4 border-accent-500 py-2 pl-4 hover:border-accent-600 md:border-t-4 md:border-l-0 md:pt-4 md:pb-0 md:pl-0"
              >
                <span class="text-sm font-medium text-accent-500 group-hover:text-accent-600">
                  {step.id}
                </span>
                <span class="text-sm font-medium text-text-primary">{step.name}</span>
              </a>
            ) : step.status === 'current' ? (
              <a
                href={step.href}
                aria-current="step"
                class="flex flex-col border-l-4 border-accent-500 py-2 pl-4 md:border-t-4 md:border-l-0 md:pt-4 md:pb-0 md:pl-0"
              >
                <span class="text-sm font-medium text-accent-500">{step.id}</span>
                <span class="text-sm font-medium text-text-primary">{step.name}</span>
              </a>
            ) : (
              <a
                href={step.href}
                class="group flex flex-col border-l-4 border-surface-2 py-2 pl-4 hover:border-surface-border md:border-t-4 md:border-l-0 md:pt-4 md:pb-0 md:pl-0"
              >
                <span class="text-sm font-medium text-text-secondary group-hover:text-text-primary">
                  {step.id}
                </span>
                <span class="text-sm font-medium text-text-primary">{step.name}</span>
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PanelProgressBars() {
  const steps = [
    { id: '01', name: 'Job details', href: '#', status: 'complete' },
    { id: '02', name: 'Application form', href: '#', status: 'current' },
    { id: '03', name: 'Preview', href: '#', status: 'upcoming' },
  ];

  return (
    <nav aria-label="Progress">
      <ol
        role="list"
        class="divide-y divide-surface-border rounded-md border border-surface-border md:flex md:divide-y-0"
      >
        {steps.map((step, stepIdx) => (
          <li key={step.name} class="relative md:flex md:flex-1">
            {step.status === 'complete' ? (
              <a href={step.href} class="group flex w-full items-center">
                <span class="flex items-center px-6 py-4 text-sm font-medium">
                  <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-500 group-hover:bg-accent-600">
                    <svg
                      aria-hidden="true"
                      class="size-6 text-white"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </span>
                  <span class="ml-4 text-sm font-medium text-text-primary">{step.name}</span>
                </span>
              </a>
            ) : step.status === 'current' ? (
              <a
                href={step.href}
                aria-current="step"
                class="flex items-center px-6 py-4 text-sm font-medium"
              >
                <span class="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-accent-500">
                  <span class="text-accent-500">{step.id}</span>
                </span>
                <span class="ml-4 text-sm font-medium text-accent-500">{step.name}</span>
              </a>
            ) : (
              <a href={step.href} class="group flex items-center">
                <span class="flex items-center px-6 py-4 text-sm font-medium">
                  <span class="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-surface-border group-hover:border-surface-border/80">
                    <span class="text-text-secondary group-hover:text-text-primary">{step.id}</span>
                  </span>
                  <span class="ml-4 text-sm font-medium text-text-secondary group-hover:text-text-primary">
                    {step.name}
                  </span>
                </span>
              </a>
            )}

            {stepIdx !== steps.length - 1 ? (
              <div aria-hidden="true" class="absolute top-0 right-0 hidden h-full w-5 md:block">
                <svg
                  fill="none"
                  viewBox="0 0 22 80"
                  preserveAspectRatio="none"
                  class="size-full text-surface-border"
                >
                  <path
                    d="M0 -2L20 40L0 82"
                    stroke="currentColor"
                    vector-effect="non-scaling-stroke"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function BulletProgressBars() {
  const steps = [
    { name: 'Step 1', href: '#', status: 'complete' },
    { name: 'Step 2', href: '#', status: 'current' },
    { name: 'Step 3', href: '#', status: 'upcoming' },
    { name: 'Step 4', href: '#', status: 'upcoming' },
  ];

  return (
    <nav aria-label="Progress" class="flex items-center justify-center">
      <p class="text-sm font-medium text-text-primary">
        Step {steps.findIndex((step) => step.status === 'current') + 1} of {steps.length}
      </p>
      <ol role="list" class="ml-8 flex items-center space-x-5">
        {steps.map((step) => (
          <li key={step.name}>
            {step.status === 'complete' ? (
              <a
                href={step.href}
                class="block size-2.5 rounded-full bg-accent-500 hover:bg-accent-600"
              >
                <span class="sr-only">{step.name}</span>
              </a>
            ) : step.status === 'current' ? (
              <a
                href={step.href}
                aria-current="step"
                class="relative flex items-center justify-center"
              >
                <span aria-hidden="true" class="absolute flex size-5 p-px">
                  <span class="size-full rounded-full bg-accent-900/20" />
                </span>
                <span
                  aria-hidden="true"
                  class="relative block size-2.5 rounded-full bg-accent-500"
                />
                <span class="sr-only">{step.name}</span>
              </a>
            ) : (
              <a
                href={step.href}
                class="block size-2.5 rounded-full bg-surface-2 hover:bg-surface-border"
              >
                <span class="sr-only">{step.name}</span>
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function CirclesProgressBars() {
  const steps = [
    { name: 'Step 1', href: '#', status: 'complete' },
    { name: 'Step 2', href: '#', status: 'complete' },
    { name: 'Step 3', href: '#', status: 'current' },
    { name: 'Step 4', href: '#', status: 'upcoming' },
    { name: 'Step 5', href: '#', status: 'upcoming' },
  ];

  return (
    <nav aria-label="Progress">
      <ol role="list" class="flex items-center">
        {steps.map((step, stepIdx) => (
          <li
            key={step.name}
            class={classNames(stepIdx !== steps.length - 1 ? 'pr-8 sm:pr-20' : '', 'relative')}
          >
            {step.status === 'complete' ? (
              <>
                <div aria-hidden="true" class="absolute inset-0 flex items-center">
                  <div class="h-0.5 w-full bg-accent-500 dark:bg-accent-500" />
                </div>
                <a
                  href="#"
                  class="relative flex size-8 items-center justify-center rounded-full bg-accent-500 hover:bg-accent-600 dark:bg-accent-500 dark:hover:bg-accent-400"
                >
                  <Check aria-hidden="true" class="size-5 text-white" />
                  <span class="sr-only">{step.name}</span>
                </a>
              </>
            ) : step.status === 'current' ? (
              <>
                <div aria-hidden="true" class="absolute inset-0 flex items-center">
                  <div class="h-0.5 w-full bg-surface-2 dark:bg-white/15" />
                </div>
                <a
                  href="#"
                  aria-current="step"
                  class="relative flex size-8 items-center justify-center rounded-full border-2 border-accent-500 bg-white dark:border-accent-500 dark:bg-surface-2"
                >
                  <span
                    aria-hidden="true"
                    class="size-2.5 rounded-full bg-accent-500 dark:bg-accent-500"
                  />
                  <span class="sr-only">{step.name}</span>
                </a>
              </>
            ) : (
              <>
                <div aria-hidden="true" class="absolute inset-0 flex items-center">
                  <div class="h-0.5 w-full bg-surface-2 dark:bg-white/15" />
                </div>
                <a
                  href="#"
                  class="group relative flex size-8 items-center justify-center rounded-full border-2 border-surface-border bg-white hover:border-surface-border/80 dark:border-white/15 dark:bg-surface-2 dark:hover:border-white/25"
                >
                  <span
                    aria-hidden="true"
                    class="size-2.5 rounded-full bg-transparent group-hover:bg-surface-2 dark:group-hover:bg-white/15"
                  />
                  <span class="sr-only">{step.name}</span>
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PanelsWithBorderProgressBars() {
  const steps = [
    {
      id: '01',
      name: 'Job Details',
      description: 'Vitae sed mi luctus laoreet.',
      href: '#',
      status: 'complete',
    },
    {
      id: '02',
      name: 'Application form',
      description: 'Cursus semper viverra.',
      href: '#',
      status: 'current',
    },
    {
      id: '03',
      name: 'Preview',
      description: 'Penatibus eu quis ante.',
      href: '#',
      status: 'upcoming',
    },
  ];

  return (
    <div class="lg:border-t lg:border-b lg:border-surface-border dark:lg:border-white/15">
      <nav aria-label="Progress" class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <ol
          role="list"
          class="overflow-hidden rounded-md lg:flex lg:rounded-none lg:border-r lg:border-l lg:border-surface-border dark:lg:border-white/15"
        >
          {steps.map((step, stepIdx) => (
            <li key={step.id} class="relative overflow-hidden lg:flex-1">
              <div
                class={classNames(
                  stepIdx === 0 ? 'rounded-t-md border-b-0' : '',
                  stepIdx === steps.length - 1 ? 'rounded-b-md border-t-0' : '',
                  'overflow-hidden border border-surface-border lg:border-0 dark:border-white/15'
                )}
              >
                {step.status === 'complete' ? (
                  <a href={step.href} class="group">
                    <span
                      aria-hidden="true"
                      class="absolute top-0 left-0 h-full w-1 bg-transparent group-hover:bg-surface-2 lg:top-auto lg:bottom-0 lg:h-1 lg:w-full dark:group-hover:bg-white/20"
                    />
                    <span
                      class={classNames(
                        stepIdx !== 0 ? 'lg:pl-9' : '',
                        'flex items-start px-6 py-5 text-sm font-medium'
                      )}
                    >
                      <span class="shrink-0">
                        <span class="flex size-10 items-center justify-center rounded-full bg-accent-500 dark:bg-accent-500">
                          <Check aria-hidden="true" class="size-6 text-white" />
                        </span>
                      </span>
                      <span class="mt-0.5 ml-4 flex min-w-0 flex-col">
                        <span class="text-sm font-medium text-text-primary">{step.name}</span>
                        <span class="text-sm font-medium text-text-secondary">
                          {step.description}
                        </span>
                      </span>
                    </span>
                  </a>
                ) : step.status === 'current' ? (
                  <a href={step.href} aria-current="step">
                    <span
                      aria-hidden="true"
                      class="absolute top-0 left-0 h-full w-1 bg-accent-500 lg:top-auto lg:bottom-0 lg:h-1 lg:w-full dark:bg-accent-500"
                    />
                    <span
                      class={classNames(
                        stepIdx !== 0 ? 'lg:pl-9' : '',
                        'flex items-start px-6 py-5 text-sm font-medium'
                      )}
                    >
                      <span class="shrink-0">
                        <span class="flex size-10 items-center justify-center rounded-full border-2 border-accent-500 dark:border-accent-500">
                          <span class="text-accent-500 dark:text-accent-400">{step.id}</span>
                        </span>
                      </span>
                      <span class="mt-0.5 ml-4 flex min-w-0 flex-col">
                        <span class="text-sm font-medium text-accent-500 dark:text-accent-400">
                          {step.name}
                        </span>
                        <span class="text-sm font-medium text-text-secondary">
                          {step.description}
                        </span>
                      </span>
                    </span>
                  </a>
                ) : (
                  <a href={step.href} class="group">
                    <span
                      aria-hidden="true"
                      class="absolute top-0 left-0 h-full w-1 bg-transparent group-hover:bg-surface-2 lg:top-auto lg:bottom-0 lg:h-1 lg:w-full dark:group-hover:bg-white/20"
                    />
                    <span
                      class={classNames(
                        stepIdx !== 0 ? 'lg:pl-9' : '',
                        'flex items-start px-6 py-5 text-sm font-medium'
                      )}
                    >
                      <span class="shrink-0">
                        <span class="flex size-10 items-center justify-center rounded-full border-2 border-surface-border dark:border-white/15">
                          <span class="text-text-secondary dark:text-text-tertiary">{step.id}</span>
                        </span>
                      </span>
                      <span class="mt-0.5 ml-4 flex min-w-0 flex-col">
                        <span class="text-sm font-medium text-text-secondary">{step.name}</span>
                        <span class="text-sm font-medium text-text-secondary">
                          {step.description}
                        </span>
                      </span>
                    </span>
                  </a>
                )}

                {stepIdx !== 0 ? (
                  <>
                    <div
                      aria-hidden="true"
                      class="absolute inset-0 top-0 left-0 hidden w-3 lg:block"
                    >
                      <svg
                        fill="none"
                        viewBox="0 0 12 82"
                        preserveAspectRatio="none"
                        class="size-full text-surface-2 dark:text-white/15"
                      >
                        <path
                          d="M0.5 0V31L10.5 41L0.5 51V82"
                          stroke="currentcolor"
                          vector-effect="non-scaling-stroke"
                        />
                      </svg>
                    </div>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

export function CirclesProgressBarsText() {
  const steps = [
    { name: 'Create account', href: '#', status: 'complete' },
    { name: 'Profile information', href: '#', status: 'current' },
    { name: 'Theme', href: '#', status: 'upcoming' },
    { name: 'Preview', href: '#', status: 'upcoming' },
  ];

  return (
    <div class="px-4 py-12 sm:px-6 lg:px-8">
      <nav aria-label="Progress" class="flex justify-center">
        <ol role="list" class="space-y-6">
          {steps.map((step) => (
            <li key={step.name}>
              {step.status === 'complete' ? (
                <a href={step.href} class="group">
                  <span class="flex items-start">
                    <span class="relative flex size-5 shrink-0 items-center justify-center">
                      <Check
                        aria-hidden="true"
                        class="size-full text-accent-500 group-hover:text-accent-600 dark:text-accent-400 dark:group-hover:text-accent-300"
                      />
                    </span>
                    <span class="ml-3 text-sm font-medium text-text-secondary group-hover:text-text-primary dark:text-text-tertiary dark:group-hover:text-text-secondary">
                      {step.name}
                    </span>
                  </span>
                </a>
              ) : step.status === 'current' ? (
                <a href={step.href} aria-current="step" class="flex items-start">
                  <span
                    aria-hidden="true"
                    class="relative flex size-5 shrink-0 items-center justify-center"
                  >
                    <span class="absolute size-4 rounded-full bg-accent-900/20 dark:bg-accent-900" />
                    <span class="relative block size-2 rounded-full bg-accent-500 dark:bg-accent-400" />
                  </span>
                  <span class="ml-3 text-sm font-medium text-accent-500 dark:text-accent-400">
                    {step.name}
                  </span>
                </a>
              ) : (
                <a href={step.href} class="group">
                  <div class="flex items-start">
                    <div
                      aria-hidden="true"
                      class="relative flex size-5 shrink-0 items-center justify-center"
                    >
                      <div class="size-2 rounded-full bg-surface-2 group-hover:bg-surface-border dark:bg-white/15 dark:group-hover:bg-white/25" />
                    </div>
                    <p class="ml-3 text-sm font-medium text-text-secondary group-hover:text-text-primary dark:text-text-tertiary dark:group-hover:text-text-secondary">
                      {step.name}
                    </p>
                  </div>
                </a>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

export function BulletsAndTextProgressBars() {
  const steps = [
    {
      name: 'Create account',
      description: 'Vitae sed mi luctus laoreet.',
      href: '#',
      status: 'complete',
    },
    {
      name: 'Profile information',
      description: 'Cursus semper viverra facilisis et et some more.',
      href: '#',
      status: 'current',
    },
    {
      name: 'Business information',
      description: 'Penatibus eu quis ante.',
      href: '#',
      status: 'upcoming',
    },
    { name: 'Theme', description: 'Faucibus nec enim leo et.', href: '#', status: 'upcoming' },
    {
      name: 'Preview',
      description: 'Iusto et officia maiores porro ad non quas.',
      href: '#',
      status: 'upcoming',
    },
  ];

  return (
    <nav aria-label="Progress">
      <ol role="list" class="overflow-hidden">
        {steps.map((step, stepIdx) => (
          <li
            key={step.name}
            class={classNames(stepIdx !== steps.length - 1 ? 'pb-10' : '', 'relative')}
          >
            {step.status === 'complete' ? (
              <>
                {stepIdx !== steps.length - 1 ? (
                  <div
                    aria-hidden="true"
                    class="absolute top-4 left-4 mt-0.5 -ml-px h-full w-0.5 bg-accent-500 dark:bg-accent-500"
                  />
                ) : null}
                <a href={step.href} class="group relative flex items-start">
                  <span class="flex h-9 items-center">
                    <span class="relative z-10 flex size-8 items-center justify-center rounded-full bg-accent-500 group-hover:bg-accent-600 dark:bg-accent-500 dark:group-hover:bg-accent-600">
                      <Check aria-hidden="true" class="size-5 text-white" />
                    </span>
                  </span>
                  <span class="ml-4 flex min-w-0 flex-col">
                    <span class="text-sm font-medium text-text-primary">{step.name}</span>
                    <span class="text-sm text-text-secondary">{step.description}</span>
                  </span>
                </a>
              </>
            ) : step.status === 'current' ? (
              <>
                {stepIdx !== steps.length - 1 ? (
                  <div
                    aria-hidden="true"
                    class="absolute top-4 left-4 mt-0.5 -ml-px h-full w-0.5 bg-surface-2 dark:bg-surface-2"
                  />
                ) : null}
                <a href={step.href} aria-current="step" class="group relative flex items-start">
                  <span aria-hidden="true" class="flex h-9 items-center">
                    <span class="relative z-10 flex size-8 items-center justify-center rounded-full border-2 border-accent-500 bg-white dark:border-accent-500 dark:bg-surface-2">
                      <span class="size-2.5 rounded-full bg-accent-500 dark:bg-accent-500" />
                    </span>
                  </span>
                  <span class="ml-4 flex min-w-0 flex-col">
                    <span class="text-sm font-medium text-accent-500 dark:text-accent-400">
                      {step.name}
                    </span>
                    <span class="text-sm text-text-secondary">{step.description}</span>
                  </span>
                </a>
              </>
            ) : (
              <>
                {stepIdx !== steps.length - 1 ? (
                  <div
                    aria-hidden="true"
                    class="absolute top-4 left-4 mt-0.5 -ml-px h-full w-0.5 bg-surface-2 dark:bg-white/15"
                  />
                ) : null}
                <a href={step.href} class="group relative flex items-start">
                  <span aria-hidden="true" class="flex h-9 items-center">
                    <span class="relative z-10 flex size-8 items-center justify-center rounded-full border-2 border-surface-border bg-white group-hover:border-surface-border/80 dark:border-white/15 dark:bg-surface-2 dark:group-hover:border-white/25">
                      <span class="size-2.5 rounded-full bg-transparent group-hover:bg-surface-2 dark:group-hover:bg-white/15" />
                    </span>
                  </span>
                  <span class="ml-4 flex min-w-0 flex-col">
                    <span class="text-sm font-medium text-text-secondary">{step.name}</span>
                    <span class="text-sm text-text-secondary">{step.description}</span>
                  </span>
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ProgressBarsDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple Steps</h3>
        <SimpleProgressBars />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Panels</h3>
        <PanelProgressBars />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Bullets</h3>
        <BulletProgressBars />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Circles</h3>
        <CirclesProgressBars />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Panels with border</h3>
        <PanelsWithBorderProgressBars />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Bullets and text</h3>
        <BulletsAndTextProgressBars />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Circles with text</h3>
        <CirclesProgressBarsText />
      </div>
    </div>
  );
}
