import { useState } from 'preact/hooks';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Transition,
  TransitionChild,
} from '../../src/mod.ts';
import {
  ArrowRightLeft,
  ArrowUpCircle,
  ArrowDownCircle,
  BarChart3,
  Bell,
  ChevronRight,
  ChevronsUpDown,
  Ellipsis,
  FileText,
  Folder,
  Globe,
  Menu as MenuIcon,
  Plus,
  Server,
  Settings,
  Signal,
  X,
} from 'lucide-preact';

function HomeScreensSidebar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigation = [
    { name: 'Home', href: '#' },
    { name: 'Invoices', href: '#' },
    { name: 'Clients', href: '#' },
    { name: 'Expenses', href: '#' },
  ];
  const secondaryNavigation = [
    { name: 'Last 7 days', href: '#', current: true },
    { name: 'Last 30 days', href: '#', current: false },
    { name: 'All-time', href: '#', current: false },
  ];
  const stats = [
    { name: 'Revenue', value: '$405,091.00', change: '+4.75%', changeType: 'positive' },
    { name: 'Overdue invoices', value: '$12,787.00', change: '+54.02%', changeType: 'negative' },
    {
      name: 'Outstanding invoices',
      value: '$245,988.00',
      change: '-1.39%',
      changeType: 'positive',
    },
    { name: 'Expenses', value: '$30,156.00', change: '+10.18%', changeType: 'negative' },
  ];
  const statuses: Record<string, string> = {
    Paid: 'text-green-700 bg-green-50 ring-green-600/20 dark:bg-green-500/10 dark:text-green-500 dark:ring-green-500/10',
    Withdraw:
      'text-gray-600 bg-gray-50 ring-gray-500/10 dark:bg-white/5 dark:text-gray-400 dark:ring-white/10',
    Overdue:
      'text-red-700 bg-red-50 ring-red-600/10 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/10',
  };
  const days = [
    {
      date: 'Today',
      dateTime: '2023-03-22',
      transactions: [
        {
          id: 1,
          invoiceNumber: '00012',
          href: '#',
          amount: '$7,600.00 USD',
          tax: '$500.00',
          status: 'Paid',
          client: 'Reform',
          description: 'Website redesign',
          icon: ArrowUpCircle,
        },
        {
          id: 2,
          invoiceNumber: '00011',
          href: '#',
          amount: '$10,000.00 USD',
          status: 'Withdraw',
          client: 'Tom Cook',
          description: 'Salary',
          icon: ArrowDownCircle,
        },
        {
          id: 3,
          invoiceNumber: '00009',
          href: '#',
          amount: '$2,000.00 USD',
          tax: '$130.00',
          status: 'Overdue',
          client: 'Tuple',
          description: 'Logo design',
          icon: ArrowRightLeft,
        },
      ],
    },
    {
      date: 'Yesterday',
      dateTime: '2023-03-21',
      transactions: [
        {
          id: 4,
          invoiceNumber: '00010',
          href: '#',
          amount: '$14,000.00 USD',
          tax: '$900.00',
          status: 'Paid',
          client: 'SavvyCal',
          description: 'Website redesign',
          icon: ArrowUpCircle,
        },
      ],
    },
  ];
  const clients = [
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
  ];

  return (
    <div class="bg-white dark:bg-gray-900">
      <header class="absolute inset-x-0 top-0 z-50 flex h-16 border-b border-gray-900/10 dark:border-white/10">
        <div class="mx-auto flex w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div class="flex flex-1 items-center gap-x-6">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              class="-m-3 p-3 md:hidden"
            >
              <span class="sr-only">Open main menu</span>
              <MenuIcon aria-hidden="true" class="size-5 text-gray-900 dark:text-white" />
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
              class="-m-2.5 p-2.5 text-gray-400 hover:text-gray-500 dark:hover:text-white"
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
          <DialogPanel class="fixed inset-y-0 left-0 z-50 w-full overflow-y-auto bg-white px-4 pb-6 sm:max-w-sm sm:px-6 sm:ring-1 sm:ring-gray-900/10 dark:bg-gray-900 dark:sm:ring-white/10">
            <div class="-ml-0.5 flex h-16 items-center gap-x-6">
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

      <main>
        <div class="relative isolate overflow-hidden pt-16">
          <header class="pt-6 pb-4 sm:pb-6">
            <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-6 px-4 sm:flex-nowrap sm:px-6 lg:px-8">
              <h1 class="text-base/7 font-semibold text-gray-900 dark:text-white">Cashflow</h1>
              <div class="order-last flex w-full gap-x-8 text-sm/6 font-semibold sm:order-0 sm:w-auto sm:border-l sm:border-gray-200 sm:pl-6 sm:text-sm/7 dark:sm:border-white/10">
                {secondaryNavigation.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    class={
                      item.current
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-gray-700 dark:text-gray-300'
                    }
                  >
                    {item.name}
                  </a>
                ))}
              </div>
              <a
                href="#"
                class="ml-auto flex items-center gap-x-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
              >
                <Plus aria-hidden="true" class="-ml-1.5 size-5" />
                New invoice
              </a>
            </div>
          </header>

          <div class="border-b border-b-gray-900/10 lg:border-t lg:border-t-gray-900/5 dark:border-b-white/10 dark:lg:border-t-white/5">
            <dl class="mx-auto grid max-w-7xl grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 lg:px-2 xl:px-0">
              {stats.map((stat, statIdx) => (
                <div
                  key={stat.name}
                  class={[
                    statIdx % 2 === 1 ? 'sm:border-l' : statIdx === 2 ? 'lg:border-l' : '',
                    'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-gray-900/5 px-4 py-10 sm:px-6 lg:border-t-0 xl:px-8 dark:border-white/5',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <dt class="text-sm/6 font-medium text-gray-500 dark:text-gray-400">
                    {stat.name}
                  </dt>
                  <dd
                    class={[
                      stat.changeType === 'negative'
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-gray-700 dark:text-gray-300',
                      'text-xs font-medium',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {stat.change}
                  </dd>
                  <dd class="w-full flex-none text-3xl/10 font-medium tracking-tight text-gray-900 dark:text-white">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div
            aria-hidden="true"
            class="absolute top-full left-0 -z-10 mt-96 origin-top-left translate-y-40 -rotate-90 transform-gpu opacity-20 blur-3xl sm:left-1/2 sm:-mt-10 sm:-ml-96 sm:translate-y-0 sm:rotate-0 sm:opacity-50 dark:opacity-10 dark:sm:opacity-30"
          >
            <div
              style={{
                clipPath:
                  'polygon(100% 38.5%, 82.6% 100%, 60.2% 37.7%, 52.4% 32.1%, 47.5% 41.8%, 45.2% 65.6%, 27.5% 23.4%, 0.1% 35.3%, 17.9% 0%, 27.7% 23.4%, 76.2% 2.5%, 74.2% 56%, 100% 38.5%)',
              }}
              class="aspect-1154/678 w-288.5 bg-linear-to-br from-[#FF80B5] to-[#9089FC]"
            />
          </div>
        </div>

        <div class="space-y-16 py-16 xl:space-y-20">
          <div>
            <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <h2 class="mx-auto max-w-2xl text-base font-semibold text-gray-900 lg:mx-0 lg:max-w-none dark:text-white">
                Recent activity
              </h2>
            </div>
            <div class="mt-6 overflow-hidden border-t border-gray-100 dark:border-white/5">
              <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div class="mx-auto max-w-2xl lg:mx-0 lg:max-w-none">
                  <table class="w-full text-left">
                    <thead class="sr-only">
                      <tr>
                        <th>Amount</th>
                        <th class="hidden sm:table-cell">Client</th>
                        <th>More details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {days.map((day) => (
                        <>
                          <tr key={day.dateTime} class="text-sm/6 text-gray-900 dark:text-white">
                            <th
                              scope="colgroup"
                              colSpan={3}
                              class="relative isolate py-2 font-semibold"
                            >
                              <time dateTime={day.dateTime}>{day.date}</time>
                              <div class="absolute inset-y-0 right-full -z-10 w-screen border-b border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/2.5" />
                              <div class="absolute inset-y-0 left-0 -z-10 w-screen border-b border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/2.5" />
                            </th>
                          </tr>
                          {day.transactions.map((transaction) => (
                            <tr key={transaction.id}>
                              <td class="relative py-5 pr-6">
                                <div class="flex gap-x-6">
                                  <transaction.icon
                                    aria-hidden="true"
                                    class="hidden h-6 w-5 flex-none text-gray-400 sm:block dark:text-gray-500"
                                  />
                                  <div class="flex-auto">
                                    <div class="flex items-start gap-x-3">
                                      <div class="text-sm/6 font-medium text-gray-900 dark:text-white">
                                        {transaction.amount}
                                      </div>
                                      <div
                                        class={[
                                          statuses[transaction.status],
                                          'rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
                                        ]
                                          .filter(Boolean)
                                          .join(' ')}
                                      >
                                        {transaction.status}
                                      </div>
                                    </div>
                                    {transaction.tax ? (
                                      <div class="mt-1 text-xs/5 text-gray-500 dark:text-gray-400">
                                        {transaction.tax} tax
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                                <div class="absolute right-full bottom-0 h-px w-screen bg-gray-100 dark:bg-white/5" />
                                <div class="absolute bottom-0 left-0 h-px w-screen bg-gray-100 dark:bg-white/5" />
                              </td>
                              <td class="hidden py-5 pr-6 sm:table-cell">
                                <div class="text-sm/6 text-gray-900 dark:text-white">
                                  {transaction.client}
                                </div>
                                <div class="mt-1 text-xs/5 text-gray-500 dark:text-gray-400">
                                  {transaction.description}
                                </div>
                              </td>
                              <td class="py-5 text-right">
                                <div class="flex justify-end">
                                  <a
                                    href={transaction.href}
                                    class="text-sm/6 font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                                  >
                                    View<span class="hidden sm:inline"> transaction</span>
                                    <span class="sr-only">
                                      , invoice #{transaction.invoiceNumber}, {transaction.client}
                                    </span>
                                  </a>
                                </div>
                                <div class="mt-1 text-xs/5 text-gray-500 dark:text-gray-400">
                                  Invoice{' '}
                                  <span class="text-gray-900 dark:text-white">
                                    #{transaction.invoiceNumber}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div class="mx-auto max-w-2xl lg:mx-0 lg:max-w-none">
              <div class="flex items-center justify-between">
                <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">
                  Recent clients
                </h2>
                <a
                  href="#"
                  class="text-sm/6 font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  View all<span class="sr-only">, clients</span>
                </a>
              </div>
              <ul
                role="list"
                class="mt-6 grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-3 xl:gap-x-8"
              >
                {clients.map((client) => (
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
                      <div class="text-sm/6 font-medium text-gray-900 dark:text-white">
                        {client.name}
                      </div>
                      <Menu as="div" class="relative ml-auto">
                        <MenuButton class="relative block text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-white">
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Open options</span>
                          <Ellipsis aria-hidden="true" class="size-5" />
                        </MenuButton>
                        <MenuItems
                          transition
                          class="absolute right-0 z-10 mt-0.5 w-32 origin-top-right rounded-md bg-white py-2 shadow-lg outline-1 outline-gray-900/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                        >
                          <MenuItem>
                            <a
                              href="#"
                              class="block px-3 py-1 text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                            >
                              View<span class="sr-only">, {client.name}</span>
                            </a>
                          </MenuItem>
                          <MenuItem>
                            <a
                              href="#"
                              class="block px-3 py-1 text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                            >
                              Edit<span class="sr-only">, {client.name}</span>
                            </a>
                          </MenuItem>
                        </MenuItems>
                      </Menu>
                    </div>
                    <dl class="-my-3 divide-y divide-gray-100 px-6 py-4 text-sm/6 dark:divide-white/10">
                      <div class="flex justify-between gap-x-4 py-3">
                        <dt class="text-gray-500 dark:text-gray-400">Last invoice</dt>
                        <dd class="text-gray-700 dark:text-gray-300">
                          <time dateTime={client.lastInvoice.dateTime}>
                            {client.lastInvoice.date}
                          </time>
                        </dd>
                      </div>
                      <div class="flex justify-between gap-x-4 py-3">
                        <dt class="text-gray-500 dark:text-gray-400">Amount</dt>
                        <dd class="flex items-start gap-x-2">
                          <div class="font-medium text-gray-900 dark:text-white">
                            {client.lastInvoice.amount}
                          </div>
                          <div
                            class={[
                              statuses[client.lastInvoice.status],
                              'rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {client.lastInvoice.status}
                          </div>
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function HomeScreensStacked() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navigation = [
    { name: 'Projects', href: '#', icon: Folder, current: false },
    { name: 'Deployments', href: '#', icon: Server, current: true },
    { name: 'Activity', href: '#', icon: Signal, current: false },
    { name: 'Domains', href: '#', icon: Globe, current: false },
    { name: 'Usage', href: '#', icon: BarChart3, current: false },
    { name: 'Settings', href: '#', icon: Settings, current: false },
  ];
  const teams = [
    { id: 1, name: 'Planetaria', href: '#', initial: 'P', current: false },
    { id: 2, name: 'Protocol', href: '#', initial: 'P', current: false },
    { id: 3, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  ];
  const statuses: Record<string, string> = {
    offline: 'text-gray-400 bg-gray-100 dark:text-gray-500 dark:bg-gray-100/10',
    online: 'text-green-500 bg-green-500/10 dark:text-green-400 dark:bg-green-400/10',
    error: 'text-rose-500 bg-rose-500/10 dark:text-rose-400 dark:bg-rose-400/10',
  };
  const environments: Record<string, string> = {
    Preview:
      'text-gray-500 bg-gray-50 ring-gray-200 dark:text-gray-400 dark:bg-gray-400/10 dark:ring-gray-400/20',
    Production:
      'text-indigo-500 bg-indigo-50 ring-indigo-200 dark:text-indigo-400 dark:bg-indigo-400/10 dark:ring-indigo-400/30',
  };
  const deployments = [
    {
      id: 1,
      href: '#',
      projectName: 'ios-app',
      teamName: 'Planetaria',
      status: 'offline',
      statusText: 'Initiated 1m 32s ago',
      description: 'Deploys from GitHub',
      environment: 'Preview',
    },
    {
      id: 2,
      href: '#',
      projectName: 'mobile-api',
      teamName: 'Planetaria',
      status: 'online',
      statusText: 'Deployed 3m ago',
      description: 'Deploys from GitHub',
      environment: 'Production',
    },
    {
      id: 3,
      href: '#',
      projectName: 'tailwindcss.com',
      teamName: 'Tailwind Labs',
      status: 'offline',
      statusText: 'Deployed 3h ago',
      description: 'Deploys from GitHub',
      environment: 'Preview',
    },
    {
      id: 4,
      href: '#',
      projectName: 'company-website',
      teamName: 'Tailwind Labs',
      status: 'online',
      statusText: 'Deployed 1d ago',
      description: 'Deploys from GitHub',
      environment: 'Preview',
    },
    {
      id: 5,
      href: '#',
      projectName: 'relay-service',
      teamName: 'Protocol',
      status: 'online',
      statusText: 'Deployed 1d ago',
      description: 'Deploys from GitHub',
      environment: 'Production',
    },
    {
      id: 6,
      href: '#',
      projectName: 'android-app',
      teamName: 'Planetaria',
      status: 'online',
      statusText: 'Deployed 5d ago',
      description: 'Deploys from GitHub',
      environment: 'Preview',
    },
    {
      id: 7,
      href: '#',
      projectName: 'api.protocol.chat',
      teamName: 'Protocol',
      status: 'error',
      statusText: 'Failed to deploy 6d ago',
      description: 'Deploys from GitHub',
      environment: 'Preview',
    },
    {
      id: 8,
      href: '#',
      projectName: 'planetaria.tech',
      teamName: 'Planetaria',
      status: 'online',
      statusText: 'Deployed 6d ago',
      description: 'Deploys from GitHub',
      environment: 'Preview',
    },
  ];
  const activityItems = [
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
    {
      user: {
        name: 'Courtney Henry',
        imageUrl:
          'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      projectName: 'company-website',
      commit: 'dad28e95',
      branch: 'main',
      date: '2d',
      dateTime: '2023-01-21T13:00',
    },
    {
      user: {
        name: 'Michael Foster',
        imageUrl:
          'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      projectName: 'relay-service',
      commit: '624bc94c',
      branch: 'main',
      date: '5d',
      dateTime: '2023-01-18T12:34',
    },
    {
      user: {
        name: 'Courtney Henry',
        imageUrl:
          'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      projectName: 'api.protocol.chat',
      commit: 'e111f80e',
      branch: 'main',
      date: '1w',
      dateTime: '2023-01-16T15:54',
    },
    {
      user: {
        name: 'Michael Foster',
        imageUrl:
          'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      projectName: 'api.protocol.chat',
      commit: '5e136005',
      branch: 'main',
      date: '1w',
      dateTime: '2023-01-16T11:31',
    },
    {
      user: {
        name: 'Whitney Francis',
        imageUrl:
          'https://images.unsplash.com/photo-1517365830460-955ce3ccd263?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      projectName: 'ios-app',
      commit: '5c1fd07f',
      branch: 'main',
      date: '2w',
      dateTime: '2023-01-09T08:45',
    },
  ];

  return (
    <div class="h-screen overflow-hidden bg-white dark:bg-gray-900">
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 xl:hidden">
        <Transition show={sidebarOpen}>
          <DialogBackdrop
            transition
            class="fixed inset-0 bg-gray-900/80 transition-opacity duration-300 ease-linear data-closed:opacity-0"
          />

          <div class="fixed inset-0 flex">
            <DialogPanel
              transition
              class="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-closed:-translate-x-full"
            >
              <TransitionChild
                enter="transition duration-300 ease-in-out"
                enterFrom="opacity-0"
                enterTo="opacity-100"
                leave="transition duration-300 ease-in-out"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
              >
                <div class="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-closed:opacity-0">
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
                              class={[
                                item.current
                                  ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                                  : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <item.icon
                                aria-hidden="true"
                                class={[
                                  item.current
                                    ? 'text-indigo-600 dark:text-white'
                                    : 'text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-white',
                                  'size-6 shrink-0',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              />
                              {item.name}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </li>
                    <li>
                      <div class="text-xs/6 font-semibold text-gray-400">Your teams</div>
                      <ul role="list" class="-mx-2 mt-2 space-y-1">
                        {teams.map((team) => (
                          <li key={team.name}>
                            <a
                              href={team.href}
                              class={[
                                team.current
                                  ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                                  : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                                'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <span
                                class={[
                                  team.current
                                    ? 'border-indigo-600 text-indigo-600 dark:border-white/20 dark:text-white'
                                    : 'border-gray-200 text-gray-400 group-hover:border-indigo-600 group-hover:text-indigo-600 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                                  'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-white text-[0.625rem] font-medium dark:bg-white/5',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
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
          </div>
        </Transition>
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
                        class={[
                          item.current
                            ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <item.icon
                          aria-hidden="true"
                          class={[
                            item.current
                              ? 'text-indigo-600 dark:text-white'
                              : 'text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-white',
                            'size-6 shrink-0',
                          ]
                            .filter(Boolean)
                            .join(' ')}
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
                        class={[
                          team.current
                            ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <span
                          class={[
                            team.current
                              ? 'border-indigo-600 text-indigo-600 dark:border-white/20 dark:text-white'
                              : 'border-gray-200 text-gray-400 group-hover:border-indigo-600 group-hover:text-indigo-600 dark:border-white/10 dark:group-hover:border-white/20 dark:group-hover:text-white',
                            'flex size-6 shrink-0 items-center justify-center rounded-lg border bg-white text-[0.625rem] font-medium dark:bg-white/5',
                          ]
                            .filter(Boolean)
                            .join(' ')}
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
            <MenuIcon aria-hidden="true" class="size-5" />
          </button>

          <div class="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
            <form action="#" method="GET" class="grid flex-1 grid-cols-1">
              <input
                name="search"
                placeholder="Search"
                aria-label="Search"
                class="col-start-1 row-start-1 block size-full bg-transparent pl-8 text-base text-gray-900 outline-hidden placeholder:text-gray-400 sm:text-sm/6 dark:text-white dark:placeholder:text-gray-500"
              />
              <FileText
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 size-5 self-center text-gray-400 dark:text-gray-500"
              />
            </form>
          </div>
        </div>

        <main class="lg:pr-96">
          <header class="flex items-center justify-between border-b border-gray-200 px-4 py-4 sm:px-6 sm:py-6 lg:px-8 dark:border-white/5">
            <h1 class="text-base/7 font-semibold text-gray-900 dark:text-white">Deployments</h1>

            <Menu as="div" class="relative">
              <MenuButton class="flex items-center gap-x-1 text-sm/6 font-medium text-gray-900 dark:text-white">
                Sort by
                <ChevronsUpDown aria-hidden="true" class="size-5 text-gray-500" />
              </MenuButton>
              <MenuItems
                transition
                class="absolute right-0 z-10 mt-2.5 w-40 origin-top-right rounded-md bg-white py-2 shadow-lg outline-1 outline-gray-900/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
              >
                <MenuItem>
                  <a
                    href="#"
                    class="block px-3 py-1 text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                  >
                    Name
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-3 py-1 text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                  >
                    Date updated
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-3 py-1 text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                  >
                    Environment
                  </a>
                </MenuItem>
              </MenuItems>
            </Menu>
          </header>

          <ul role="list" class="divide-y divide-gray-100 dark:divide-white/5">
            {deployments.map((deployment) => (
              <li
                key={deployment.id}
                class="relative flex items-center space-x-4 px-4 py-4 sm:px-6 lg:px-8"
              >
                <div class="min-w-0 flex-auto">
                  <div class="flex items-center gap-x-3">
                    <div
                      class={['flex-none rounded-full p-1', statuses[deployment.status]]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div class="size-2 rounded-full bg-current" />
                    </div>
                    <h2 class="min-w-0 text-sm/6 font-semibold text-gray-900 dark:text-white">
                      <a href={deployment.href} class="flex gap-x-2">
                        <span class="truncate">{deployment.teamName}</span>
                        <span class="text-gray-400">/</span>
                        <span class="whitespace-nowrap">{deployment.projectName}</span>
                        <span class="absolute inset-0" />
                      </a>
                    </h2>
                  </div>
                  <div class="mt-3 flex items-center gap-x-2.5 text-xs/5 text-gray-500 dark:text-gray-400">
                    <p class="truncate">{deployment.description}</p>
                    <svg
                      viewBox="0 0 2 2"
                      class="size-0.5 flex-none fill-gray-300 dark:fill-gray-500"
                    >
                      <circle r={1} cx={1} cy={1} />
                    </svg>
                    <p class="whitespace-nowrap">{deployment.statusText}</p>
                  </div>
                </div>
                <div
                  class={[
                    'flex-none rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset',
                    environments[deployment.environment],
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {deployment.environment}
                </div>
                <ChevronRight aria-hidden="true" class="size-5 flex-none text-gray-400" />
              </li>
            ))}
          </ul>
        </main>

        <aside class="bg-gray-50 lg:fixed lg:top-16 lg:right-0 lg:bottom-0 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-gray-200 dark:bg-black/10 dark:lg:border-white/5">
          <header class="flex items-center justify-between border-b border-gray-200 px-4 py-4 sm:px-6 sm:py-6 lg:px-8 dark:border-white/5">
            <h2 class="text-base/7 font-semibold text-gray-900 dark:text-white">Activity feed</h2>
            <a href="#" class="text-sm/6 font-semibold text-indigo-600 dark:text-indigo-400">
              View all
            </a>
          </header>
          <ul role="list" class="divide-y divide-gray-100 dark:divide-white/5">
            {activityItems.map((item) => (
              <li key={item.commit} class="px-4 py-4 sm:px-6 lg:px-8">
                <div class="flex items-center gap-x-3">
                  <img
                    alt=""
                    src={item.user.imageUrl}
                    class="size-6 flex-none rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                  />
                  <h3 class="flex-auto truncate text-sm/6 font-semibold text-gray-900 dark:text-white">
                    {item.user.name}
                  </h3>
                  <time
                    dateTime={item.dateTime}
                    class="flex-none text-xs text-gray-500 dark:text-gray-600"
                  >
                    {item.date}
                  </time>
                </div>
                <p class="mt-3 truncate text-sm text-gray-500">
                  Pushed to <span class="text-gray-700 dark:text-gray-400">{item.projectName}</span>{' '}
                  (<span class="font-mono text-gray-700 dark:text-gray-400">{item.commit}</span> on{' '}
                  <span class="text-gray-700 dark:text-gray-400">{item.branch}</span>)
                </p>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

export function HomeScreensDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Home screen — Sidebar layout (Cashflow)
        </h3>
        <div class="page-preview rounded-xl border border-surface-border overflow-auto">
          <HomeScreensSidebar />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Home screen — Stacked layout (Deployments)
        </h3>
        <div class="page-preview rounded-xl border border-surface-border overflow-auto">
          <HomeScreensStacked />
        </div>
      </div>
    </div>
  );
}
