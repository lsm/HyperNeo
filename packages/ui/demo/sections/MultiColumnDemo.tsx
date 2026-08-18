import { Menu, Home, Users, Folder, Calendar, Copy, PieChart } from 'lucide-preact';
import { classNames } from '../../src/internal/class-names.ts';

const navigation = [
  { name: 'Dashboard', href: '#', icon: Home, current: true },
  { name: 'Team', href: '#', icon: Users, current: false },
  { name: 'Projects', href: '#', icon: Folder, current: false },
  { name: 'Calendar', href: '#', icon: Calendar, current: false },
  { name: 'Documents', href: '#', icon: Copy, current: false },
  { name: 'Reports', href: '#', icon: PieChart, current: false },
];
const teams = [
  { id: 1, name: 'Heroicons', href: '#', initial: 'H', current: false },
  { id: 2, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  { id: 3, name: 'Workcation', href: '#', initial: 'W', current: false },
];

function FullWidthThreeColumn() {
  return (
    <div>
      <div class="relative grid grid-cols-1 gap-x-16 md:grid-cols-2 lg:grid-cols-3">
        <button
          type="button"
          class="absolute -top-1 -left-1.5 flex items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
        >
          <span class="sr-only">Open sidebar</span>
          <Menu aria-hidden="true" class="size-6" />
        </button>

        <div class="col-span-1 lg:col-span-2">
          <div class="bg-surface-0 dark:bg-surface-2/50 p-6 rounded-lg min-h-32">
            <h4 class="text-sm font-medium text-text-primary dark:text-white">Main Content Area</h4>
            <p class="mt-1 text-xs text-text-secondary dark:text-text-tertiary">
              Full-width three column layout with sidebar navigation
            </p>
          </div>
        </div>

        <div class="col-span-1">
          <div class="bg-surface-0 dark:bg-surface-2/50 p-6 rounded-lg min-h-32">
            <h4 class="text-sm font-medium text-text-primary dark:text-white">Secondary Panel</h4>
            <p class="mt-1 text-xs text-text-secondary dark:text-text-tertiary">
              Additional content or details
            </p>
          </div>
        </div>
      </div>

      <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
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
              </li>
              <li>
                <div class="text-xs/6 font-semibold text-text-tertiary dark:text-text-tertiary">
                  Your teams
                </div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                            : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span
                          class={classNames(
                            team.current
                              ? 'border-indigo-600 text-indigo-600 dark:border-white/20 dark:text-white'
                              : 'border-surface-border text-text-tertiary group-hover:border-accent-500 group-hover:text-accent-500 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                            'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-surface-0 text-[0.625rem] font-medium dark:bg-white/5'
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
                  class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-text-primary hover:bg-surface-0 dark:text-white dark:hover:bg-white/5"
                >
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-surface-0 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                  />
                  <span class="sr-only">Your profile</span>
                  <span aria-hidden="true">Tom Cook</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-white px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-surface-2 dark:shadow-none dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-b dark:before:border-white/10 dark:before:bg-black/10">
        <button
          type="button"
          class="relative -m-2.5 p-2.5 text-text-secondary lg:hidden dark:text-text-tertiary"
        >
          <span class="sr-only">Open sidebar</span>
          <Menu aria-hidden="true" class="size-6" />
        </button>
        <div class="relative flex-1 text-sm/6 font-semibold text-text-primary dark:text-white">
          Dashboard
        </div>
        <a href="#" class="relative">
          <span class="sr-only">Your profile</span>
          <img
            alt=""
            src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
            class="size-8 rounded-full bg-surface-0 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
          />
        </a>
      </div>

      <aside class="fixed inset-y-0 left-72 hidden w-96 overflow-y-auto border-r border-surface-border px-4 py-6 sm:px-6 lg:px-8 xl:block dark:border-white/10">
        <div class="bg-surface-0 dark:bg-surface-2/50 p-4 rounded-lg min-h-48">
          <h4 class="text-sm font-medium text-text-primary dark:text-white">Tertiary Panel</h4>
          <p class="mt-1 text-xs text-text-secondary dark:text-text-tertiary">
            Additional sidebar content
          </p>
        </div>
      </aside>
    </div>
  );
}

function FullWidthSecondaryColumnOnRight() {
  return (
    <div>
      <div class="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
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
              </li>
              <li>
                <div class="text-xs/6 font-semibold text-text-tertiary dark:text-text-tertiary">
                  Your teams
                </div>
                <ul role="list" class="-mx-2 mt-2 space-y-1">
                  {teams.map((team) => (
                    <li key={team.name}>
                      <a
                        href={team.href}
                        class={classNames(
                          team.current
                            ? 'bg-surface-0 text-accent-500 dark:bg-white/5 dark:text-white'
                            : 'text-text-secondary hover:bg-surface-0 hover:text-accent-500 dark:text-text-tertiary dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <span
                          class={classNames(
                            team.current
                              ? 'border-indigo-600 text-indigo-600 dark:border-white/20 dark:text-white'
                              : 'border-surface-border text-text-tertiary group-hover:border-accent-500 group-hover:text-accent-500 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                            'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-surface-0 text-[0.625rem] font-medium dark:bg-white/5'
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
                  class="flex items-center gap-x-4 px-6 py-3 text-sm/6 font-semibold text-text-primary hover:bg-surface-0 dark:text-white dark:hover:bg-white/5"
                >
                  <img
                    alt=""
                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                    class="size-8 rounded-full bg-surface-0 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                  />
                  <span class="sr-only">Your profile</span>
                  <span aria-hidden="true">Tom Cook</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <div class="sticky top-0 z-40 flex items-center gap-x-6 bg-white px-4 py-4 shadow-xs sm:px-6 lg:hidden dark:bg-surface-2 dark:shadow-none dark:before:pointer-events-none dark:before:absolute dark:before:inset-0 dark:before:border-b dark:before:border-white/10 dark:before:bg-black/10">
        <button
          type="button"
          class="relative -m-2.5 p-2.5 text-text-secondary lg:hidden dark:text-text-tertiary"
        >
          <span class="sr-only">Open sidebar</span>
          <Menu aria-hidden="true" class="size-6" />
        </button>
        <div class="relative flex-1 text-sm/6 font-semibold text-text-primary dark:text-white">
          Dashboard
        </div>
        <a href="#" class="relative">
          <span class="sr-only">Your profile</span>
          <img
            alt=""
            src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
            class="size-8 rounded-full bg-surface-0 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
          />
        </a>
      </div>

      <main class="lg:pl-72">
        <div class="xl:pr-96">
          <div class="bg-surface-0 dark:bg-surface-2/50 p-6 rounded-lg min-h-48">
            <h4 class="text-sm font-medium text-text-primary dark:text-white">Main Content Area</h4>
            <p class="mt-1 text-xs text-text-secondary dark:text-text-tertiary">
              Full width with secondary column on the right side
            </p>
          </div>
        </div>
      </main>

      <aside class="fixed inset-y-0 right-0 hidden w-96 overflow-y-auto border-l border-surface-border px-4 py-6 sm:px-6 lg:px-8 xl:block dark:border-white/10">
        <div class="bg-surface-0 dark:bg-surface-2/50 p-4 rounded-lg min-h-48">
          <h4 class="text-sm font-medium text-text-primary dark:text-white">
            Secondary Panel (Right)
          </h4>
          <p class="mt-1 text-xs text-text-secondary dark:text-text-tertiary">
            Content displayed on the right side
          </p>
        </div>
      </aside>
    </div>
  );
}

export function MultiColumnDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Full Width Three Column
        </h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <FullWidthThreeColumn />
        </div>
      </div>
      <div>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Full Width Secondary Column on Right
        </h3>
        <div class="shell-frame h-[32rem] rounded-lg border border-surface-border overflow-hidden">
          <FullWidthSecondaryColumnOnRight />
        </div>
      </div>
    </div>
  );
}
