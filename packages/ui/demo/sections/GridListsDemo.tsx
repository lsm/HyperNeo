import { Menu, MenuButton, MenuItems, MenuItem } from '../../src/mod.ts';
import { EllipsisVertical } from 'lucide-preact';
import { classNames } from '../../src/internal/class-names.ts';

const people = [
  {
    name: 'Jane Cooper',
    title: 'Paradigm Representative',
    role: 'Admin',
    email: 'janecooper@example.com',
    telephone: '+1-202-555-0170',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Cody Fisher',
    title: 'Lead Security Associate',
    role: 'Admin',
    email: 'codyfisher@example.com',
    telephone: '+1-202-555-0114',
    imageUrl:
      'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Esther Howard',
    title: 'Assurance Administrator',
    email: 'estherhoward@example.com',
    telephone: '+1-202-555-0143',
    role: 'Admin',
    imageUrl:
      'https://images.unsplash.com/photo-1520813792240-56fc4a3765a7?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Jenny Wilson',
    title: 'Chief Accountability Analyst',
    role: 'Admin',
    email: 'jennywilson@example.com',
    telephone: '+1-202-555-0184',
    imageUrl:
      'https://images.unsplash.com/photo-1498551172505-8ee7ad69f235?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Kristin Watson',
    title: 'Investor Data Orchestrator',
    role: 'Admin',
    email: 'kristinwatson@example.com',
    telephone: '+1-202-555-0191',
    imageUrl:
      'https://images.unsplash.com/photo-1532417344469-368f9ae6d187?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Cameron Williamson',
    title: 'Product Infrastructure Executive',
    role: 'Admin',
    email: 'cameronwilliamson@example.com',
    telephone: '+1-202-555-0108',
    imageUrl:
      'https://images.unsplash.com/photo-1566492031773-4f4e44671857?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Courtney Henry',
    title: 'Investor Factors Associate',
    role: 'Admin',
    email: 'courtneyhenry@example.com',
    telephone: '+1-202-555-0104',
    imageUrl:
      'https://images.unsplash.com/photo-1534751516642-a1af1ef26a56?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Theresa Webb',
    title: 'Global Division Officer',
    role: 'Admin',
    email: 'theresawebb@example.com',
    telephone: '+1-202-555-0138',
    imageUrl:
      'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
];

const people2 = [
  {
    name: 'Jane Cooper',
    title: 'Regional Paradigm Technician',
    role: 'Admin',
    email: 'janecooper@example.com',
    telephone: '+1-202-555-0170',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Cody Fisher',
    title: 'Product Directives Officer',
    role: 'Admin',
    email: 'codyfisher@example.com',
    telephone: '+1-202-555-0114',
    imageUrl:
      'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Esther Howard',
    title: 'Forward Response Developer',
    email: 'estherhoward@example.com',
    telephone: '+1-202-555-0143',
    role: 'Admin',
    imageUrl:
      'https://images.unsplash.com/photo-1520813792240-56fc4a3765a7?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Jenny Wilson',
    title: 'Central Security Manager',
    role: 'Admin',
    email: 'jennywilson@example.com',
    telephone: '+1-202-555-0184',
    imageUrl:
      'https://images.unsplash.com/photo-1498551172505-8ee7ad69f235?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Kristin Watson',
    title: 'Lead Implementation Liaison',
    role: 'Admin',
    email: 'kristinwatson@example.com',
    telephone: '+1-202-555-0191',
    imageUrl:
      'https://images.unsplash.com/photo-1532417344469-368f9ae6d187?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
  {
    name: 'Cameron Williamson',
    title: 'Internal Applications Engineer',
    role: 'Admin',
    email: 'cameronwilliamson@example.com',
    telephone: '+1-202-555-0108',
    imageUrl:
      'https://images.unsplash.com/photo-1566492031773-4f4e44671857?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=4&w=256&h=256&q=60',
  },
];

function MailIcon({ class: className }: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function PhoneIcon({ class: className }: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function GridListsDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Contact cards with small portrait
        </h3>
        <ul role="list" class="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {people.map((person) => (
            <li
              key={person.email}
              class="col-span-1 flex flex-col divide-y divide-surface-2 rounded-lg bg-surface-0 text-center shadow-sm dark:divide-white/10 dark:bg-surface-0/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10"
            >
              <div class="flex flex-1 flex-col p-8">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="mx-auto size-32 shrink-0 rounded-full bg-surface-3 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
                <h3 class="mt-6 text-sm font-medium text-text-primary">{person.name}</h3>
                <dl class="mt-1 flex grow flex-col justify-between">
                  <dt class="sr-only">Title</dt>
                  <dd class="text-sm text-text-secondary">{person.title}</dd>
                  <dt class="sr-only">Role</dt>
                  <dd class="mt-3">
                    <span class="inline-flex items-center rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-500 inset-ring inset-ring-green-500/10 dark:bg-green-500/10 dark:text-green-500 dark:inset-ring-green-500/10">
                      {person.role}
                    </span>
                  </dd>
                </dl>
              </div>
              <div>
                <div class="-mt-px flex divide-x divide-surface-2 dark:divide-white/10">
                  <div class="flex w-0 flex-1">
                    <a
                      href={`mailto:${person.email}`}
                      class="relative -mr-px inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-bl-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
                    >
                      <MailIcon
                        aria-hidden="true"
                        class="size-5 text-text-tertiary dark:text-text-secondary"
                      />
                      Email
                    </a>
                  </div>
                  <div class="-ml-px flex w-0 flex-1">
                    <a
                      href={`tel:${person.telephone}`}
                      class="relative inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-br-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
                    >
                      <PhoneIcon
                        aria-hidden="true"
                        class="size-5 text-text-tertiary dark:text-text-secondary"
                      />
                      Call
                    </a>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Contact cards</h3>
        <ul role="list" class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {people2.map((person) => (
            <li
              key={person.email}
              class="col-span-1 divide-y divide-surface-2 rounded-lg bg-surface-0 shadow-sm dark:divide-white/10 dark:bg-surface-0/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10"
            >
              <div class="flex w-full items-center justify-between space-x-6 p-6">
                <div class="flex-1 truncate">
                  <div class="flex items-center space-x-3">
                    <h3 class="truncate text-sm font-medium text-text-primary">{person.name}</h3>
                    <span class="inline-flex shrink-0 items-center rounded-full bg-green-500/10 px-1.5 py-0.5 text-xs font-medium text-green-500 inset-ring inset-ring-green-500/10 dark:bg-green-500/10 dark:text-green-500 dark:inset-ring-green-500/10">
                      {person.role}
                    </span>
                  </div>
                  <p class="mt-1 truncate text-sm text-text-secondary">{person.title}</p>
                </div>
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-10 shrink-0 rounded-full bg-surface-3 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </div>
              <div>
                <div class="-mt-px flex divide-x divide-surface-2 dark:divide-white/10">
                  <div class="flex w-0 flex-1">
                    <a
                      href={`mailto:${person.email}`}
                      class="relative -mr-px inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-bl-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
                    >
                      <MailIcon
                        aria-hidden="true"
                        class="size-5 text-text-tertiary dark:text-text-secondary"
                      />
                      Email
                    </a>
                  </div>
                  <div class="-ml-px flex w-0 flex-1">
                    <a
                      href={`tel:${person.telephone}`}
                      class="relative inline-flex w-0 flex-1 items-center justify-center gap-x-3 rounded-br-lg border border-transparent py-4 text-sm font-semibold text-text-primary"
                    >
                      <PhoneIcon
                        aria-hidden="true"
                        class="size-5 text-text-tertiary dark:text-text-secondary"
                      />
                      Call
                    </a>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple cards</h3>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {people2.map((person) => (
            <div
              key={person.email}
              class="relative flex items-center space-x-3 rounded-lg border border-surface-border bg-surface-0 px-6 py-5 shadow-sm hover:border-surface-border/50 focus-within:ring-2 focus-within:ring-accent-500 focus-within:ring-offset-2 dark:bg-surface-0/50 dark:shadow-none"
            >
              <div class="shrink-0">
                <img
                  alt=""
                  src={person.imageUrl}
                  class="size-10 rounded-full bg-surface-3 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
              </div>
              <div class="min-w-0 flex-1">
                <a href="#" class="focus:outline-hidden">
                  <span aria-hidden="true" class="absolute inset-0" />
                  <p class="text-sm font-medium text-text-primary">{person.name}</p>
                  <p class="truncate text-sm text-text-secondary">{person.role}</p>
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Horizontal link cards</h3>
        <div>
          <h4 class="text-sm font-medium text-text-tertiary mb-3">Pinned Projects</h4>
          <ul
            role="list"
            class="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4"
          >
            {[
              {
                name: 'Graph API',
                initials: 'GA',
                members: 16,
                bgColor: 'bg-pink-600 dark:bg-pink-700',
              },
              {
                name: 'Component Design',
                initials: 'CD',
                members: 12,
                bgColor: 'bg-purple-600 dark:bg-purple-700',
              },
              {
                name: 'Templates',
                initials: 'T',
                members: 16,
                bgColor: 'bg-yellow-500 dark:bg-yellow-600',
              },
              {
                name: 'React Components',
                initials: 'RC',
                members: 8,
                bgColor: 'bg-green-500 dark:bg-green-600',
              },
            ].map((project) => (
              <li key={project.name} class="col-span-1 flex rounded-md shadow-sm dark:shadow-none">
                <div
                  class={classNames(
                    project.bgColor,
                    'flex w-16 shrink-0 items-center justify-center rounded-l-md text-sm font-medium text-white'
                  )}
                >
                  {project.initials}
                </div>
                <div class="flex flex-1 items-center justify-between truncate rounded-r-md border-t border-r border-b border-surface-border bg-surface-0 dark:border-white/10 dark:bg-surface-0/50">
                  <div class="flex-1 truncate px-4 py-2 text-sm">
                    <a href="#" class="font-medium text-text-primary hover:text-text-secondary">
                      {project.name}
                    </a>
                    <p class="text-text-secondary">{project.members} Members</p>
                  </div>
                  <div class="shrink-0 pr-2">
                    <button
                      type="button"
                      class="inline-flex size-8 items-center justify-center rounded-full text-text-tertiary hover:text-text-secondary focus:outline-2 focus:outline-offset-2 focus:outline-accent-500 dark:hover:text-white"
                    >
                      <span class="sr-only">Open options</span>
                      <EllipsisVertical aria-hidden="true" class="size-5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Actions with shared borders</h3>
        <div class="divide-y divide-surface-border overflow-hidden rounded-lg bg-surface-2 shadow-sm sm:grid sm:grid-cols-2 sm:divide-y-0 dark:divide-white/10 dark:bg-surface-2 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/20">
          {[
            {
              title: 'Request time off',
              href: '#',
              iconBg: 'bg-teal-500/10 dark:bg-teal-500/10',
              iconFg: 'text-teal-700 dark:text-teal-400',
            },
            {
              title: 'Benefits',
              href: '#',
              iconBg: 'bg-purple-500/10 dark:bg-purple-500/10',
              iconFg: 'text-purple-700 dark:text-purple-400',
            },
            {
              title: 'Schedule a one-on-one',
              href: '#',
              iconBg: 'bg-sky-500/10 dark:bg-sky-500/10',
              iconFg: 'text-sky-700 dark:text-sky-400',
            },
            {
              title: 'Payroll',
              href: '#',
              iconBg: 'bg-yellow-500/10 dark:bg-yellow-500/10',
              iconFg: 'text-yellow-700 dark:text-yellow-400',
            },
            {
              title: 'Submit an expense',
              href: '#',
              iconBg: 'bg-rose-500/10 dark:bg-rose-500/10',
              iconFg: 'text-rose-700 dark:text-rose-400',
            },
            {
              title: 'Training',
              href: '#',
              iconBg: 'bg-indigo-500/10 dark:bg-indigo-500/10',
              iconFg: 'text-indigo-700 dark:text-indigo-400',
            },
          ].map((action, actionIdx) => (
            <div
              key={action.title}
              class={classNames(
                actionIdx === 0 ? 'rounded-tl-lg rounded-tr-lg sm:rounded-tr-none' : '',
                actionIdx === 1 ? 'sm:rounded-tr-lg' : '',
                actionIdx === 4 ? 'sm:rounded-bl-lg' : '',
                actionIdx === 5 ? 'rounded-br-lg rounded-bl-lg sm:rounded-bl-none' : '',
                'relative border-t border-r border-b border-l border-surface-border bg-surface-0 p-6 focus-within:ring-2 focus-within:ring-accent-500 focus-within:ring-offset-2 sm:border-b sm:even:border-l dark:border-white/10 dark:bg-surface-0/50'
              )}
            >
              <div>
                <span
                  class={classNames(action.iconBg, action.iconFg, 'inline-flex rounded-lg p-3')}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="size-6"
                  >
                    <path d="M12 8v4l3 3" />
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                </span>
              </div>
              <div class="mt-8">
                <h3 class="text-base font-semibold text-text-primary">
                  <a href={action.href} class="focus:outline-hidden">
                    <span aria-hidden="true" class="absolute inset-0" />
                    {action.title}
                  </a>
                </h3>
                <p class="mt-2 text-sm text-text-secondary">
                  Doloribus dolores nostrum quia qui natus officia quod et dolorem. Sit repellendus
                  qui ut at blanditiis et quo et molestiae.
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Images with details</h3>
        <ul
          role="list"
          class="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-6 lg:grid-cols-4 xl:gap-x-8"
        >
          {[
            {
              title: 'IMG_4985.HEIC',
              size: '3.9 MB',
              source:
                'https://images.unsplash.com/photo-1582053433976-25c00369fc93?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=512&q=80',
            },
            {
              title: 'IMG_5214.HEIC',
              size: '4 MB',
              source:
                'https://images.unsplash.com/photo-1614926857083-7be149266cda?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=crop&w=512&q=80',
            },
            {
              title: 'IMG_3851.HEIC',
              size: '3.8 MB',
              source:
                'https://images.unsplash.com/photo-1614705827065-62c3dc488f40?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=crop&w=512&q=80',
            },
            {
              title: 'IMG_4278.HEIC',
              size: '4.1 MB',
              source:
                'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=512&q=80',
            },
          ].map((file) => (
            <li key={file.source} class="relative">
              <div class="group overflow-hidden rounded-lg bg-surface-2 focus-within:ring-2 focus-within:ring-accent-500 focus-within:ring-offset-2 dark:bg-surface-2">
                <img
                  alt=""
                  src={file.source}
                  class="pointer-events-none aspect-[10/7] rounded-lg object-cover bg-surface-3 outline -outline-offset-1 outline-black/5 group-hover:opacity-75 dark:outline-white/10"
                />
                <button type="button" class="absolute inset-0 focus:outline-hidden">
                  <span class="sr-only">View details for {file.title}</span>
                </button>
              </div>
              <p class="pointer-events-none mt-2 block truncate text-sm font-medium text-text-primary">
                {file.title}
              </p>
              <p class="pointer-events-none block text-sm font-medium text-text-secondary">
                {file.size}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Logos cards with description list
        </h3>
        <ul role="list" class="grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-3 xl:gap-x-8">
          {[
            {
              id: 1,
              name: 'Tuple',
              imageUrl: 'https://tailwindcss.com/plus-assets/img/logos/48x48/tuple.svg',
              lastInvoice: {
                date: 'December 13, 2022',
                dateTime: '2022-12-13',
                amount: '$2,000.00',
                status: 'Overdue',
              },
            },
            {
              id: 2,
              name: 'SavvyCal',
              imageUrl: 'https://tailwindcss.com/plus-assets/img/logos/48x48/savvycal.svg',
              lastInvoice: {
                date: 'January 22, 2023',
                dateTime: '2023-01-22',
                amount: '$14,000.00',
                status: 'Paid',
              },
            },
            {
              id: 3,
              name: 'Reform',
              imageUrl: 'https://tailwindcss.com/plus-assets/img/logos/48x48/reform.svg',
              lastInvoice: {
                date: 'January 23, 2023',
                dateTime: '2023-01-23',
                amount: '$7,600.00',
                status: 'Paid',
              },
            },
          ].map((client) => (
            <li
              key={client.id}
              class="overflow-hidden rounded-xl outline outline-gray-200 dark:-outline-offset-1 dark:outline-white/10"
            >
              <div class="flex items-center gap-x-4 border-b border-gray-900/5 bg-gray-50 p-6 dark:border-white/10 dark:bg-gray-800/50">
                <img
                  alt={client.name}
                  src={client.imageUrl}
                  class="size-12 flex-none rounded-lg bg-white object-cover ring-1 ring-gray-900/10 dark:bg-gray-700 dark:ring-white/10"
                />
                <div class="text-sm/6 font-medium text-gray-900 dark:text-white">{client.name}</div>
                <Menu as="div" class="relative ml-auto">
                  <MenuButton class="relative block text-gray-400 hover:text-gray-500 dark:text-gray-400 dark:hover:text-white cursor-pointer">
                    <span class="absolute -inset-2.5" />
                    <span class="sr-only">Open options</span>
                    <EllipsisVertical aria-hidden="true" class="size-5" />
                  </MenuButton>
                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-0.5 w-32 origin-top-right rounded-md bg-surface-1 py-2 shadow-xl border border-surface-border transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in outline-none"
                  >
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                      >
                        View<span class="sr-only">, {client.name}</span>
                      </a>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                      >
                        Edit<span class="sr-only">, {client.name}</span>
                      </a>
                    </MenuItem>
                  </MenuItems>
                </Menu>
              </div>
              <dl class="-my-3 divide-y divide-surface-2 px-6 py-4 text-sm/6 dark:divide-white/10">
                <div class="flex justify-between gap-x-4 py-3">
                  <dt class="text-text-secondary">Last invoice</dt>
                  <dd class="text-text-primary">
                    <time dateTime={client.lastInvoice.dateTime}>{client.lastInvoice.date}</time>
                  </dd>
                </div>
                <div class="flex justify-between gap-x-4 py-3">
                  <dt class="text-text-secondary">Amount</dt>
                  <dd class="flex items-start gap-x-2">
                    <div class="font-medium text-text-primary">{client.lastInvoice.amount}</div>
                    {client.lastInvoice.status == 'Paid' ? (
                      <div class="rounded-md bg-green-500/10 px-2 py-1 text-xs font-medium text-green-500 ring-1 ring-inset ring-green-500/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20">
                        {client.lastInvoice.status}
                      </div>
                    ) : null}
                    {client.lastInvoice.status == 'Overdue' ? (
                      <div class="rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500 ring-1 ring-inset ring-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20">
                        {client.lastInvoice.status}
                      </div>
                    ) : null}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
