import { Menu, MenuButton, MenuItems, MenuItem } from '../../src/mod.ts';
import { EllipsisVertical } from 'lucide-preact';

const people = [
  {
    name: 'Leslie Alexander',
    email: 'leslie.alexander@example.com',
    role: 'Co-Founder / CEO',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    href: '#',
    lastSeen: '3h ago',
    lastSeenDateTime: '2023-01-23T13:23Z',
  },
  {
    name: 'Michael Foster',
    email: 'michael.foster@example.com',
    role: 'Co-Founder / CTO',
    imageUrl:
      'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    href: '#',
    lastSeen: '3h ago',
    lastSeenDateTime: '2023-01-23T13:23Z',
  },
  {
    name: 'Dries Vincent',
    email: 'dries.vincent@example.com',
    role: 'Business Relations',
    imageUrl:
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    href: '#',
    lastSeen: null,
  },
  {
    name: 'Lindsay Walton',
    email: 'lindsay.walton@example.com',
    role: 'Front-end Developer',
    imageUrl:
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    href: '#',
    lastSeen: '3h ago',
    lastSeenDateTime: '2023-01-23T13:23Z',
  },
  {
    name: 'Courtney Henry',
    email: 'courtney.henry@example.com',
    role: 'Designer',
    imageUrl:
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    href: '#',
    lastSeen: '3h ago',
    lastSeenDateTime: '2023-01-23T13:23Z',
  },
  {
    name: 'Tom Cook',
    email: 'tom.cook@example.com',
    role: 'Director of Product',
    imageUrl:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    href: '#',
    lastSeen: null,
  },
];

function ChevronRightIcon({ class: className }: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      class={className}
    >
      <path
        fill-rule="evenodd"
        d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function OnlineIndicator() {
  return (
    <div class="mt-1 flex items-center gap-x-1.5">
      <div class="flex-none rounded-full bg-green-500/20 p-1 dark:bg-green-500/30">
        <div class="size-1.5 rounded-full bg-green-500" />
      </div>
      <p class="text-xs/5 text-text-secondary">Online</p>
    </div>
  );
}

function PersonRowSimple({ person }: { person: (typeof people)[0] }) {
  return (
    <li class="relative flex justify-between gap-x-6 px-4 py-5 hover:bg-surface-1 sm:px-6 dark:hover:bg-white/2.5">
      <div class="flex min-w-0 gap-x-4">
        <img
          alt=""
          src={person.imageUrl}
          class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
        />
        <div class="min-w-0 flex-auto">
          <p class="text-sm/6 font-semibold text-text-primary">
            <a href={person.href}>
              <span class="absolute inset-x-0 -top-px bottom-0" />
              {person.name}
            </a>
          </p>
          <p class="mt-1 flex text-xs/5 text-text-secondary">
            <a href={`mailto:${person.email}`} class="relative truncate hover:underline">
              {person.email}
            </a>
          </p>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-x-4">
        <div class="hidden sm:flex sm:flex-col sm:items-end">
          <p class="text-sm/6 text-text-primary">{person.role}</p>
          {person.lastSeen ? (
            <p class="mt-1 text-xs/5 text-text-secondary">
              Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
            </p>
          ) : (
            <OnlineIndicator />
          )}
        </div>
        <ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
      </div>
    </li>
  );
}

function PersonRowTwoColumns({ person }: { person: (typeof people)[0] }) {
  return (
    <li key={person.email} class="relative flex justify-between py-5">
      <div class="flex gap-x-4 pr-6 sm:w-1/2 sm:flex-none">
        <img
          alt=""
          src={person.imageUrl}
          class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
        />
        <div class="min-w-0 flex-auto">
          <p class="text-sm/6 font-semibold text-text-primary">
            <a href={person.href}>
              <span class="absolute inset-x-0 -top-px bottom-0" />
              {person.name}
            </a>
          </p>
          <p class="mt-1 flex text-xs/5 text-text-secondary">
            <a href={`mailto:${person.email}`} class="relative truncate hover:underline">
              {person.email}
            </a>
          </p>
        </div>
      </div>
      <div class="flex items-center justify-between gap-x-4 sm:w-1/2 sm:flex-none">
        <div class="hidden sm:block">
          <p class="text-sm/6 text-text-primary">{person.role}</p>
          {person.lastSeen ? (
            <p class="mt-1 text-xs/5 text-text-secondary">
              Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
            </p>
          ) : (
            <OnlineIndicator />
          )}
        </div>
        <ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
      </div>
    </li>
  );
}

function PersonRowFullWidth({ person }: { person: (typeof people)[0] }) {
  return (
    <li key={person.email} class="relative py-5 hover:bg-surface-1 dark:hover:bg-white/2.5">
      <div class="px-4 sm:px-6 lg:px-8">
        <div class="mx-auto flex max-w-4xl justify-between gap-x-6">
          <div class="flex min-w-0 gap-x-4">
            <img
              alt=""
              src={person.imageUrl}
              class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
            />
            <div class="min-w-0 flex-auto">
              <p class="text-sm/6 font-semibold text-text-primary">
                <a href={person.href}>
                  <span class="absolute inset-x-0 -top-px bottom-0" />
                  {person.name}
                </a>
              </p>
              <p class="mt-1 flex text-xs/5 text-text-secondary">
                <a href={`mailto:${person.email}`} class="relative truncate hover:underline">
                  {person.email}
                </a>
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-x-4">
            <div class="hidden sm:flex sm:flex-col sm:items-end">
              <p class="text-sm/6 text-text-primary">{person.role}</p>
              {person.lastSeen ? (
                <p class="mt-1 text-xs/5 text-text-secondary">
                  Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
                </p>
              ) : (
                <OnlineIndicator />
              )}
            </div>
            <ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
          </div>
        </div>
      </div>
    </li>
  );
}

function PersonRowPlain({ person }: { person: (typeof people)[0] }) {
  return (
    <li key={person.email} class="flex justify-between gap-x-6 py-5">
      <div class="flex min-w-0 gap-x-4">
        <img
          alt=""
          src={person.imageUrl}
          class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
        />
        <div class="min-w-0 flex-auto">
          <p class="text-sm/6 font-semibold text-text-primary">{person.name}</p>
          <p class="mt-1 truncate text-xs/5 text-text-secondary">{person.email}</p>
        </div>
      </div>
      <div class="hidden shrink-0 sm:flex sm:flex-col sm:items-end">
        <p class="text-sm/6 text-text-primary">{person.role}</p>
        {person.lastSeen ? (
          <p class="mt-1 text-xs/5 text-text-secondary">
            Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
          </p>
        ) : (
          <OnlineIndicator />
        )}
      </div>
    </li>
  );
}

export function StackedListsDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple stacked list in card</h3>
        <ul
          role="list"
          class="divide-y divide-surface-2 overflow-hidden bg-surface-0 shadow-sm outline outline-1 outline-black/5 sm:rounded-xl dark:divide-white/5 dark:bg-surface-0/50 dark:shadow-none dark:outline-white/10 dark:sm:-outline-offset-1"
        >
          {people.map((person) => (
            <PersonRowSimple person={person} />
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Plain stacked list with links</h3>
        <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
          {people.map((person) => (
            <li
              key={person.email}
              class="relative flex justify-between gap-x-6 px-4 py-5 hover:bg-surface-1 sm:px-6 lg:px-8 dark:hover:bg-white/2.5"
            >
              <div class="flex min-w-0 gap-x-4">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
                />
                <div class="min-w-0 flex-auto">
                  <p class="text-sm/6 font-semibold text-text-primary">
                    <a href={person.href}>
                      <span class="absolute inset-x-0 -top-px bottom-0" />
                      {person.name}
                    </a>
                  </p>
                  <p class="mt-1 flex text-xs/5 text-text-secondary">
                    <a href={`mailto:${person.email}`} class="relative truncate hover:underline">
                      {person.email}
                    </a>
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-x-4">
                <div class="hidden sm:flex sm:flex-col sm:items-end">
                  <p class="text-sm/6 text-text-primary">{person.role}</p>
                  {person.lastSeen ? (
                    <p class="mt-1 text-xs/5 text-text-secondary">
                      Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
                    </p>
                  ) : (
                    <OnlineIndicator />
                  )}
                </div>
                <ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Stacked list in card</h3>
        <div class="overflow-hidden bg-surface-0 shadow-sm outline outline-1 outline-black/5 dark:bg-surface-0/50 dark:shadow-none dark:outline-white/10 sm:rounded-xl">
          <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
            {people.map((person) => (
              <PersonRowPlain person={person} />
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Two columns with links</h3>
        <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
          {people.map((person) => (
            <PersonRowTwoColumns person={person} />
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Full width with links</h3>
        <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
          {people.map((person) => (
            <PersonRowFullWidth person={person} />
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Full width with constrained content
        </h3>
        <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
          {people.map((person) => (
            <li key={person.email} class="relative flex justify-between gap-x-6 py-5">
              <div class="flex min-w-0 gap-x-4">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
                />
                <div class="min-w-0 flex-auto">
                  <p class="text-sm/6 font-semibold text-text-primary">
                    <a href={person.href}>
                      <span class="absolute inset-x-0 -top-px bottom-0" />
                      {person.name}
                    </a>
                  </p>
                  <p class="mt-1 flex text-xs/5 text-text-secondary">
                    <a href={`mailto:${person.email}`} class="relative truncate hover:underline">
                      {person.email}
                    </a>
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-x-4">
                <div class="hidden sm:flex sm:flex-col sm:items-end">
                  <p class="text-sm/6 text-text-primary">{person.role}</p>
                  {person.lastSeen ? (
                    <p class="mt-1 text-xs/5 text-text-secondary">
                      Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
                    </p>
                  ) : (
                    <OnlineIndicator />
                  )}
                </div>
                <ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Narrow with actions</h3>
        <div class="overflow-hidden bg-surface-0 shadow-sm outline outline-1 outline-black/5 dark:bg-surface-0/50 dark:shadow-none dark:outline-white/10 sm:rounded-xl">
          <ul role="list" class="divide-y divide-surface-border dark:divide-white/5">
            {[
              {
                title: 'Request time off',
                description: 'Doloribus dolores nostrum quia qui natus officia quod et dolorem.',
              },
              {
                title: 'Benefits',
                description: 'Doloribus dolores nostrum quia qui natus officia quod et dolorem.',
              },
              {
                title: 'Schedule a one-on-one',
                description: 'Doloribus dolores nostrum quia qui natus officia quod et dolorem.',
              },
            ].map((item, idx) => (
              <li
                key={idx}
                class="flex items-center justify-between gap-x-6 py-5 pl-4 pr-5 sm:pl-6"
              >
                <div class="flex min-w-0 gap-x-4">
                  <div class="min-w-0 flex-auto">
                    <p class="text-sm/6 font-semibold text-text-primary">{item.title}</p>
                    <p class="mt-1 truncate text-xs/5 text-text-secondary">{item.description}</p>
                  </div>
                </div>
                <a
                  href="#"
                  class="rounded-full bg-surface-0 px-2.5 py-1 text-xs font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 dark:bg-surface-0/50 dark:shadow-none dark:hover:bg-surface-1"
                >
                  View<span class="sr-only">, {item.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Narrow with truncated content</h3>
        <ul role="list" class="divide-y divide-surface-border dark:divide-white/5">
          {[
            {
              name: 'Leslie Alexander',
              email: 'leslie.alexander@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
            },
            {
              name: 'Michael Foster',
              email: 'michael.foster@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
            },
            {
              name: 'Dries Vincent',
              email: 'dries.vincent@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
            },
            {
              name: 'Lindsay Walton',
              email: 'lindsay.walton@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
            },
          ].map((person) => (
            <li key={person.email} class="flex gap-x-4 py-5">
              <img
                alt=""
                src={person.imageUrl}
                class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
              />
              <div class="flex-auto">
                <div class="flex items-baseline justify-between gap-x-4">
                  <p class="text-sm/6 font-semibold text-text-primary">{person.name}</p>
                  <p class="flex-none text-xs text-text-tertiary">
                    <time dateTime="2023-03-04">1d ago</time>
                  </p>
                </div>
                <p class="mt-1 line-clamp-2 text-sm/6 text-text-secondary">
                  Explicabo nihil laborum. Saepe facilis consequuntur in eaque. Consequatur
                  perspiciatis quam. Sed est illo quia. Culpa vitae placeat vitae. Repudiandae sunt
                  exercitationem nihil nisi facilis placeat minima eveniet.
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Narrow with small avatars</h3>
        <ul role="list" class="divide-y divide-surface-border dark:divide-white/5">
          {people.map((person) => (
            <li key={person.email} class="relative flex items-center space-x-4 py-4">
              <div class="min-w-0 flex-auto">
                <div class="flex items-center gap-x-3">
                  <div class="flex-none rounded-full bg-surface-1/10 p-1 text-text-tertiary">
                    <div class="size-2 rounded-full bg-current" />
                  </div>
                  <h2 class="min-w-0 text-sm/6 font-semibold text-text-primary">
                    <a href={person.href} class="flex gap-x-2">
                      <span class="truncate">{person.name}</span>
                      <span class="text-text-tertiary">/</span>
                      <span class="whitespace-nowrap">ios-app</span>
                      <span class="absolute inset-0" />
                    </a>
                  </h2>
                </div>
                <div class="mt-3 flex items-center gap-x-2 text-xs/5 text-text-secondary">
                  <p class="truncate">Deploys from GitHub</p>
                  <svg viewBox="0 0 2 2" class="size-0.5 flex-none fill-text-tertiary">
                    <circle r={1} cx={1} cy={1} />
                  </svg>
                  <p class="whitespace-nowrap">Deployed 3m ago</p>
                </div>
              </div>
              <div class="flex-none rounded-full bg-surface-1 px-2 py-1 text-xs font-medium text-text-secondary ring-1 ring-surface-border dark:bg-surface-2 dark:text-text-tertiary">
                Preview
              </div>
              <ChevronRightIcon class="size-5 flex-none text-text-tertiary" />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Activity with icons</h3>
        <ul role="list" class="divide-y divide-surface-border dark:divide-white/5">
          {[
            {
              user: {
                name: 'Michael Foster',
                imageUrl:
                  'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              },
              projectName: 'ios-app',
              commit: '2d89f0c8',
              branch: 'main',
              date: '1h',
              dateTime: '2023-01-23T11:00',
            },
            {
              user: {
                name: 'Lindsay Walton',
                imageUrl:
                  'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              },
              projectName: 'mobile-api',
              commit: '249df660',
              branch: 'main',
              date: '3h',
              dateTime: '2023-01-23T09:00',
            },
            {
              user: {
                name: 'Courtney Henry',
                imageUrl:
                  'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              },
              projectName: 'ios-app',
              commit: '11464223',
              branch: 'main',
              date: '12h',
              dateTime: '2023-01-23T00:00',
            },
          ].map((item) => (
            <li key={item.commit} class="py-4">
              <div class="flex items-center gap-x-3">
                <img
                  alt=""
                  src={item.user.imageUrl}
                  class="size-6 flex-none rounded-full bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
                />
                <h3 class="flex-auto truncate text-sm/6 font-semibold text-text-primary">
                  {item.user.name}
                </h3>
                <time dateTime={item.dateTime} class="flex-none text-xs text-text-secondary">
                  {item.date}
                </time>
              </div>
              <p class="mt-3 truncate text-sm text-text-secondary">
                Pushed to <span class="text-text-primary">{item.projectName}</span> (
                <span class="font-mono text-text-secondary">{item.commit}</span> on{' '}
                <span class="text-text-secondary">{item.branch}</span>)
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Narrow with badges</h3>
        <ul role="list" class="divide-y divide-surface-border dark:divide-white/5">
          {[
            {
              name: 'Leslie Alexander',
              email: 'leslie.alexander@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              role: 'Admin',
            },
            {
              name: 'Michael Foster',
              email: 'michael.foster@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              role: 'Member',
            },
            {
              name: 'Dries Vincent',
              email: 'dries.vincent@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              role: 'Member',
            },
            {
              name: 'Lindsay Walton',
              email: 'lindsay.walton@example.com',
              imageUrl:
                'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              role: 'Admin',
            },
          ].map((person) => (
            <li key={person.email} class="flex justify-between gap-x-6 py-5">
              <div class="flex min-w-0 gap-x-4">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
                />
                <div class="min-w-0 flex-auto">
                  <p class="text-sm/6 font-semibold text-text-primary">{person.name}</p>
                  <p class="mt-1 truncate text-xs/5 text-text-secondary">{person.email}</p>
                </div>
              </div>
              <div class="shrink-0 sm:flex sm:flex-col sm:items-end">
                <span class="inline-flex items-center rounded-full bg-accent-500/10 px-2 py-1 text-xs font-medium text-accent-500 ring-1 ring-accent-500/20 dark:bg-accent-500/10 dark:text-accent-400 dark:ring-accent-500/20">
                  {person.role}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple list</h3>
        <ul role="list" class="divide-y divide-surface-border dark:divide-white/5">
          {people.map((person) => (
            <li
              key={person.email}
              class="relative flex justify-between gap-x-6 px-4 py-5 hover:bg-surface-1 sm:px-6 dark:hover:bg-white/2.5"
            >
              <div class="flex min-w-0 gap-x-4">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
                />
                <div class="min-w-0 flex-auto">
                  <p class="text-sm/6 font-semibold text-text-primary">
                    <a href={person.href}>
                      <span class="absolute inset-x-0 -top-px bottom-0" />
                      {person.name}
                    </a>
                  </p>
                  <p class="mt-1 flex text-xs/5 text-text-secondary">
                    <a href={`mailto:${person.email}`} class="relative truncate hover:underline">
                      {person.email}
                    </a>
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-x-4">
                <div class="hidden sm:flex sm:flex-col sm:items-end">
                  <p class="text-sm/6 text-text-primary">{person.role}</p>
                  {person.lastSeen ? (
                    <p class="mt-1 text-xs/5 text-text-secondary">
                      Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
                    </p>
                  ) : (
                    <OnlineIndicator />
                  )}
                </div>
                <ChevronRightIcon class="size-5 flex-none text-text-tertiary dark:text-text-secondary" />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          With inline links and actions menu
        </h3>
        <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
          {[
            {
              name: 'Leslie Alexander',
              email: 'leslie.alexander@example.com',
              role: 'Co-Founder / CEO',
              imageUrl:
                'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              lastSeen: '3h ago',
              lastSeenDateTime: '2023-01-23T13:23Z',
            },
            {
              name: 'Michael Foster',
              email: 'michael.foster@example.com',
              role: 'Co-Founder / CTO',
              imageUrl:
                'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              lastSeen: '3h ago',
              lastSeenDateTime: '2023-01-23T13:23Z',
            },
            {
              name: 'Dries Vincent',
              email: 'dries.vincent@example.com',
              role: 'Business Relations',
              imageUrl:
                'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
              href: '#',
              lastSeen: null,
            },
          ].map((person) => (
            <li key={person.email} class="flex justify-between gap-x-6 py-5">
              <div class="flex min-w-0 gap-x-4">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-12 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
                />
                <div class="min-w-0 flex-auto">
                  <p class="text-sm/6 font-semibold text-text-primary">
                    <a href={person.href} class="hover:underline">
                      {person.name}
                    </a>
                  </p>
                  <p class="mt-1 flex text-xs/5 text-text-secondary">
                    <a href={`mailto:${person.email}`} class="truncate hover:underline">
                      {person.email}
                    </a>
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-x-6">
                <div class="hidden sm:flex sm:flex-col sm:items-end">
                  <p class="text-sm/6 text-text-primary">{person.role}</p>
                  {person.lastSeen ? (
                    <p class="mt-1 text-xs/5 text-text-secondary">
                      Last seen <time dateTime={person.lastSeenDateTime}>{person.lastSeen}</time>
                    </p>
                  ) : (
                    <div class="mt-1 flex items-center gap-x-1.5">
                      <div class="flex-none rounded-full bg-green-500/20 p-1 dark:bg-green-500/30">
                        <div class="size-1.5 rounded-full bg-green-500" />
                      </div>
                      <p class="text-xs/5 text-text-secondary">Online</p>
                    </div>
                  )}
                </div>
                <Menu as="div" class="relative flex-none">
                  <MenuButton class="relative block text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white cursor-pointer">
                    <span class="absolute -inset-2.5" />
                    <span class="sr-only">Open options</span>
                    <EllipsisVertical aria-hidden="true" class="size-5" />
                  </MenuButton>
                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2 w-32 origin-top-right rounded-md bg-surface-1 shadow-xl border border-surface-border transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in outline-none"
                  >
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                      >
                        View profile<span class="sr-only">, {person.name}</span>
                      </a>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                      >
                        Message<span class="sr-only">, {person.name}</span>
                      </a>
                    </MenuItem>
                  </MenuItems>
                </Menu>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          With badges, button and actions menu
        </h3>
        <ul role="list" class="divide-y divide-surface-2 dark:divide-white/5">
          {[
            {
              id: 1,
              name: 'GraphQL API',
              href: '#',
              status: 'Complete',
              createdBy: 'Leslie Alexander',
              dueDate: 'March 17, 2023',
              dueDateTime: '2023-03-17T00:00Z',
            },
            {
              id: 2,
              name: 'New benefits plan',
              href: '#',
              status: 'In progress',
              createdBy: 'Leslie Alexander',
              dueDate: 'May 5, 2023',
              dueDateTime: '2023-05-05T00:00Z',
            },
            {
              id: 3,
              name: 'Onboarding emails',
              href: '#',
              status: 'In progress',
              createdBy: 'Courtney Henry',
              dueDate: 'May 25, 2023',
              dueDateTime: '2023-05-25T00:00Z',
            },
          ].map((project) => (
            <li key={project.id} class="flex items-center justify-between gap-x-6 py-5">
              <div class="min-w-0">
                <div class="flex items-start gap-x-3">
                  <p class="text-sm/6 font-semibold text-text-primary">{project.name}</p>
                  {project.status === 'In progress' ? (
                    <p class="mt-0.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-text-secondary ring-1 ring-inset ring-surface-border/50 dark:bg-surface-2 dark:text-text-secondary">
                      {project.status}
                    </p>
                  ) : null}
                  {project.status === 'Complete' ? (
                    <p class="mt-0.5 rounded-md bg-green-500/10 px-1.5 py-0.5 text-xs font-medium text-green-500 ring-1 ring-inset ring-green-500/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20">
                      {project.status}
                    </p>
                  ) : null}
                </div>
                <div class="mt-1 flex items-center gap-x-2 text-xs/5 text-text-secondary">
                  <p class="whitespace-nowrap">
                    Due on <time dateTime={project.dueDateTime}>{project.dueDate}</time>
                  </p>
                  <svg viewBox="0 0 2 2" class="size-0.5 fill-current">
                    <circle r={1} cx={1} cy={1} />
                  </svg>
                  <p class="truncate">Created by {project.createdBy}</p>
                </div>
              </div>
              <div class="flex flex-none items-center gap-x-4">
                <a
                  href={project.href}
                  class="hidden rounded-md bg-surface-0 px-2.5 py-1.5 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 sm:block dark:bg-surface-0/50 dark:text-text-primary dark:shadow-none dark:hover:bg-surface-1"
                >
                  View project<span class="sr-only">, {project.name}</span>
                </a>
                <Menu as="div" class="relative flex-none">
                  <MenuButton class="relative block text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white cursor-pointer">
                    <span class="absolute -inset-2.5" />
                    <span class="sr-only">Open options</span>
                    <EllipsisVertical aria-hidden="true" class="size-5" />
                  </MenuButton>
                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2 w-32 origin-top-right rounded-md bg-surface-1 shadow-xl border border-surface-border transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in outline-none"
                  >
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                      >
                        Edit<span class="sr-only">, {project.name}</span>
                      </a>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                      >
                        Move<span class="sr-only">, {project.name}</span>
                      </a>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-red-400 data-[focus]:bg-red-500 data-[focus]:text-white cursor-pointer"
                      >
                        Delete<span class="sr-only">, {project.name}</span>
                      </a>
                    </MenuItem>
                  </MenuItems>
                </Menu>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
