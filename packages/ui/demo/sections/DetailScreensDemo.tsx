import { useState } from 'preact/hooks';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Transition,
  TransitionChild,
} from '../../src/mod.ts';
import {
  Bell,
  CalendarDays,
  CheckCircle,
  CreditCard,
  EllipsisVertical,
  FileText,
  Flame,
  Heart,
  Menu as MenuIcon,
  Paperclip,
  Smile,
  ThumbsUp,
  UserCircle,
  X,
} from 'lucide-preact';

function DetailScreensStacked() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selected, setSelected] = useState<{
    name: string;
    value: string | null;
    icon: typeof Flame;
    iconColor: string;
    bgColor: string;
  } | null>(null);

  const navigation = [
    { name: 'Home', href: '#' },
    { name: 'Invoices', href: '#' },
    { name: 'Clients', href: '#' },
    { name: 'Expenses', href: '#' },
  ];

  const invoice = {
    subTotal: '$8,800.00',
    tax: '$1,760.00',
    total: '$10,560.00',
    items: [
      {
        id: 1,
        title: 'Logo redesign',
        description: 'New logo and digital asset playbook.',
        hours: '20.0',
        rate: '$100.00',
        price: '$2,000.00',
      },
      {
        id: 2,
        title: 'Website redesign',
        description: 'Design and program new company website.',
        hours: '52.0',
        rate: '$100.00',
        price: '$5,200.00',
      },
      {
        id: 3,
        title: 'Business cards',
        description: 'Design and production of 3.5" x 2.0" business cards.',
        hours: '12.0',
        rate: '$100.00',
        price: '$1,200.00',
      },
      {
        id: 4,
        title: 'T-shirt design',
        description: 'Three t-shirt design concepts.',
        hours: '4.0',
        rate: '$100.00',
        price: '$400.00',
      },
    ],
  };

  const activity = [
    {
      id: 1,
      type: 'created',
      person: { name: 'Chelsea Hagon' },
      date: '7d ago',
      dateTime: '2023-01-23T10:32',
    },
    {
      id: 2,
      type: 'edited',
      person: { name: 'Chelsea Hagon' },
      date: '6d ago',
      dateTime: '2023-01-23T11:03',
    },
    {
      id: 3,
      type: 'sent',
      person: { name: 'Chelsea Hagon' },
      date: '6d ago',
      dateTime: '2023-01-23T11:24',
    },
    {
      id: 4,
      type: 'commented',
      person: {
        name: 'Chelsea Hagon',
        imageUrl:
          'https://images.unsplash.com/photo-1550525811-e5869dd03032?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      comment: 'Called client, they reassured me the invoice would be paid by the 25th.',
      date: '3d ago',
      dateTime: '2023-01-23T15:56',
    },
    {
      id: 5,
      type: 'viewed',
      person: { name: 'Alex Curren' },
      date: '2d ago',
      dateTime: '2023-01-24T09:12',
    },
    {
      id: 6,
      type: 'paid',
      person: { name: 'Alex Curren' },
      date: '1d ago',
      dateTime: '2023-01-24T09:20',
    },
  ];

  const moods = [
    {
      name: 'Excited',
      value: 'excited',
      icon: Flame,
      iconColor: 'text-white',
      bgColor: 'bg-red-500',
    },
    { name: 'Loved', value: 'loved', icon: Heart, iconColor: 'text-white', bgColor: 'bg-pink-400' },
    {
      name: 'Happy',
      value: 'happy',
      icon: Smile,
      iconColor: 'text-white',
      bgColor: 'bg-green-400',
    },
    { name: 'Sad', value: 'sad', icon: Smile, iconColor: 'text-white', bgColor: 'bg-yellow-400' },
    {
      name: 'Thumbsy',
      value: 'thumbsy',
      icon: ThumbsUp,
      iconColor: 'text-white',
      bgColor: 'bg-blue-500',
    },
    {
      name: 'I feel nothing',
      value: null,
      icon: X,
      iconColor: 'text-gray-400',
      bgColor: 'bg-transparent',
    },
  ];

  function classNames(...classes: (string | boolean | undefined)[]) {
    return classes.filter(Boolean).join(' ');
  }

  return (
    <div class="bg-white dark:bg-gray-900 min-h-0">
      <header class="absolute inset-x-0 top-0 z-50 flex h-16 border-b border-gray-900/10 dark:border-white/10">
        <div class="mx-auto flex w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div class="flex flex-1 items-center gap-x-6">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              class="-m-3 p-3 md:hidden"
            >
              <span class="sr-only">Open main menu</span>
              <MenuIcon class="size-5 text-gray-900 dark:text-white" />
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
              <Bell class="size-6" />
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
                <X class="size-6" />
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
        <header class="relative isolate pt-16">
          <div aria-hidden="true" class="absolute inset-0 -z-10 overflow-hidden">
            <div class="absolute top-full left-16 -mt-16 transform-gpu opacity-50 blur-3xl xl:left-1/2 xl:-ml-80 dark:opacity-30">
              <div
                style={{
                  clipPath:
                    'polygon(100% 38.5%, 82.6% 100%, 60.2% 37.7%, 52.4% 32.1%, 47.5% 41.8%, 45.2% 65.6%, 27.5% 23.4%, 0.1% 35.3%, 17.9% 0%, 27.7% 23.4%, 76.2% 2.5%, 74.2% 56%, 100% 38.5%)',
                }}
                class="aspect-1154/678 w-288.5 bg-linear-to-br from-[#FF80B5] to-[#9089FC]"
              />
            </div>
            <div class="absolute inset-x-0 bottom-0 h-px bg-gray-900/5 dark:bg-white/5" />
          </div>

          <div class="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
            <div class="mx-auto flex max-w-2xl items-center justify-between gap-x-8 lg:mx-0 lg:max-w-none">
              <div class="flex items-center gap-x-6">
                <img
                  alt=""
                  src="https://tailwindcss.com/plus-assets/img/logos/48x48/tuple.svg"
                  class="size-16 flex-none rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                />
                <h1>
                  <div class="text-sm/6 text-gray-500 dark:text-gray-400">
                    Invoice <span class="text-gray-700 dark:text-gray-300">#00011</span>
                  </div>
                  <div class="mt-1 text-base font-semibold text-gray-900 dark:text-white">
                    Tuple, Inc
                  </div>
                </h1>
              </div>
              <div class="flex items-center gap-x-4 sm:gap-x-6">
                <button
                  type="button"
                  class="hidden text-sm/6 font-semibold text-gray-900 sm:block dark:text-white"
                >
                  Copy URL
                </button>
                <a
                  href="#"
                  class="hidden text-sm/6 font-semibold text-gray-900 sm:block dark:text-white"
                >
                  Edit
                </a>
                <a
                  href="#"
                  class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
                >
                  Send
                </a>

                <Menu as="div" class="relative sm:hidden">
                  <MenuButton class="relative block">
                    <span class="absolute -inset-3" />
                    <span class="sr-only">More</span>
                    <EllipsisVertical class="size-5 text-gray-500 dark:text-gray-400" />
                  </MenuButton>

                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-0.5 w-32 origin-top-right rounded-md bg-white py-2 shadow-lg outline-1 outline-gray-900/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                  >
                    <MenuItem>
                      <button
                        type="button"
                        class="block w-full px-3 py-1 text-left text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                      >
                        Copy URL
                      </button>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-3 py-1 text-sm/6 text-gray-900 data-focus:bg-gray-50 data-focus:outline-hidden dark:text-white dark:data-focus:bg-white/5"
                      >
                        Edit
                      </a>
                    </MenuItem>
                  </MenuItems>
                </Menu>
              </div>
            </div>
          </div>
        </header>

        <div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <div class="mx-auto grid max-w-2xl grid-cols-1 grid-rows-1 items-start gap-x-8 gap-y-8 lg:mx-0 lg:max-w-none lg:grid-cols-3">
            <div class="lg:col-start-3 lg:row-end-1">
              <h2 class="sr-only">Summary</h2>
              <div class="rounded-lg bg-gray-50 shadow-xs outline-1 outline-gray-900/5 dark:bg-gray-800/50 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10">
                <dl class="flex flex-wrap">
                  <div class="flex-auto pt-6 pl-6">
                    <dt class="text-sm/6 font-semibold text-gray-900 dark:text-white">Amount</dt>
                    <dd class="mt-1 text-base font-semibold text-gray-900 dark:text-white">
                      $10,560.00
                    </dd>
                  </div>
                  <div class="flex-none self-end px-6 pt-4">
                    <dt class="sr-only">Status</dt>
                    <dd class="rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-600 ring-1 ring-green-600/20 ring-inset dark:bg-green-500/10 dark:text-green-500 dark:ring-green-500/30">
                      Paid
                    </dd>
                  </div>
                  <div class="mt-6 flex w-full flex-none gap-x-4 border-t border-gray-900/5 px-6 pt-6 dark:border-white/10">
                    <dt class="flex-none">
                      <span class="sr-only">Client</span>
                      <UserCircle class="h-6 w-5 text-gray-400 dark:text-gray-500" />
                    </dt>
                    <dd class="text-sm/6 font-medium text-gray-900 dark:text-white">Alex Curren</dd>
                  </div>
                  <div class="mt-4 flex w-full flex-none gap-x-4 px-6">
                    <dt class="flex-none">
                      <span class="sr-only">Due date</span>
                      <CalendarDays class="h-6 w-5 text-gray-400 dark:text-gray-500" />
                    </dt>
                    <dd class="text-sm/6 text-gray-500 dark:text-gray-400">
                      <time dateTime="2023-01-31">January 31, 2023</time>
                    </dd>
                  </div>
                  <div class="mt-4 flex w-full flex-none gap-x-4 px-6">
                    <dt class="flex-none">
                      <span class="sr-only">Status</span>
                      <CreditCard class="h-6 w-5 text-gray-400 dark:text-gray-500" />
                    </dt>
                    <dd class="text-sm/6 text-gray-500 dark:text-gray-400">Paid with MasterCard</dd>
                  </div>
                </dl>
                <div class="mt-6 border-t border-gray-900/5 px-6 py-6 dark:border-white/10">
                  <a href="#" class="text-sm/6 font-semibold text-gray-900 dark:text-white">
                    Download receipt <span aria-hidden="true">&rarr;</span>
                  </a>
                </div>
              </div>
            </div>

            <div class="-mx-4 px-4 py-8 shadow-xs ring-1 ring-gray-900/5 sm:mx-0 sm:rounded-lg sm:px-8 sm:pb-14 lg:col-span-2 lg:row-span-2 lg:row-end-2 xl:px-16 xl:pt-16 xl:pb-20 dark:shadow-none dark:ring-white/10">
              <h2 class="text-base font-semibold text-gray-900 dark:text-white">Invoice</h2>
              <dl class="mt-6 grid grid-cols-1 text-sm/6 sm:grid-cols-2">
                <div class="sm:pr-4">
                  <dt class="inline text-gray-500 dark:text-gray-400">Issued on</dt>{' '}
                  <dd class="inline text-gray-700 dark:text-gray-300">
                    <time dateTime="2023-23-01">January 23, 2023</time>
                  </dd>
                </div>
                <div class="mt-2 sm:mt-0 sm:pl-4">
                  <dt class="inline text-gray-500 dark:text-gray-400">Due on</dt>{' '}
                  <dd class="inline text-gray-700 dark:text-gray-300">
                    <time dateTime="2023-31-01">January 31, 2023</time>
                  </dd>
                </div>
                <div class="mt-6 border-t border-gray-900/5 pt-6 sm:pr-4 dark:border-white/10">
                  <dt class="font-semibold text-gray-900 dark:text-white">From</dt>
                  <dd class="mt-2 text-gray-500 dark:text-gray-400">
                    <span class="font-medium text-gray-900 dark:text-white">Acme, Inc.</span>
                    <br />
                    7363 Cynthia Pass
                    <br />
                    Toronto, ON N3Y 4H8
                  </dd>
                </div>
                <div class="mt-8 sm:mt-6 sm:border-t sm:border-gray-900/5 sm:pt-6 sm:pl-4 dark:sm:border-white/10">
                  <dt class="font-semibold text-gray-900 dark:text-white">To</dt>
                  <dd class="mt-2 text-gray-500 dark:text-gray-400">
                    <span class="font-medium text-gray-900 dark:text-white">Tuple, Inc</span>
                    <br />
                    886 Walter Street
                    <br />
                    New York, NY 12345
                  </dd>
                </div>
              </dl>
              <table class="mt-16 w-full text-left text-sm/6 whitespace-nowrap">
                <colgroup>
                  <col class="w-full" />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead class="border-b border-gray-200 text-gray-900 dark:border-white/15 dark:text-white">
                  <tr>
                    <th scope="col" class="px-0 py-3 font-semibold">
                      Projects
                    </th>
                    <th
                      scope="col"
                      class="hidden py-3 pr-0 pl-8 text-right font-semibold sm:table-cell"
                    >
                      Hours
                    </th>
                    <th
                      scope="col"
                      class="hidden py-3 pr-0 pl-8 text-right font-semibold sm:table-cell"
                    >
                      Rate
                    </th>
                    <th scope="col" class="py-3 pr-0 pl-8 text-right font-semibold">
                      Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => (
                    <tr key={item.id} class="border-b border-gray-100 dark:border-white/10">
                      <td class="max-w-0 px-0 py-5 align-top">
                        <div class="truncate font-medium text-gray-900 dark:text-white">
                          {item.title}
                        </div>
                        <div class="truncate text-gray-500 dark:text-gray-400">
                          {item.description}
                        </div>
                      </td>
                      <td class="hidden py-5 pr-0 pl-8 text-right align-top text-gray-700 tabular-nums sm:table-cell dark:text-gray-300">
                        {item.hours}
                      </td>
                      <td class="hidden py-5 pr-0 pl-8 text-right align-top text-gray-700 tabular-nums sm:table-cell dark:text-gray-300">
                        {item.rate}
                      </td>
                      <td class="py-5 pr-0 pl-8 text-right align-top text-gray-700 tabular-nums dark:text-gray-300">
                        {item.price}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th
                      scope="row"
                      class="px-0 pt-6 pb-0 font-normal text-gray-700 sm:hidden dark:text-gray-300"
                    >
                      Subtotal
                    </th>
                    <th
                      scope="row"
                      colSpan={3}
                      class="hidden px-0 pt-6 pb-0 text-right font-normal text-gray-700 sm:table-cell dark:text-gray-300"
                    >
                      Subtotal
                    </th>
                    <td class="pt-6 pr-0 pb-0 pl-8 text-right text-gray-900 tabular-nums dark:text-white">
                      {invoice.subTotal}
                    </td>
                  </tr>
                  <tr>
                    <th
                      scope="row"
                      class="pt-4 font-normal text-gray-700 sm:hidden dark:text-gray-300"
                    >
                      Tax
                    </th>
                    <th
                      scope="row"
                      colSpan={3}
                      class="hidden pt-4 text-right font-normal text-gray-700 sm:table-cell dark:text-gray-300"
                    >
                      Tax
                    </th>
                    <td class="pt-4 pr-0 pb-0 pl-8 text-right text-gray-900 tabular-nums dark:text-white">
                      {invoice.tax}
                    </td>
                  </tr>
                  <tr>
                    <th
                      scope="row"
                      class="pt-4 font-semibold text-gray-900 sm:hidden dark:text-white"
                    >
                      Total
                    </th>
                    <th
                      scope="row"
                      colSpan={3}
                      class="hidden pt-4 text-right font-semibold text-gray-900 sm:table-cell dark:text-white"
                    >
                      Total
                    </th>
                    <td class="pt-4 pr-0 pb-0 pl-8 text-right font-semibold text-gray-900 tabular-nums dark:text-white">
                      {invoice.total}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div class="lg:col-start-3">
              <h2 class="text-sm/6 font-semibold text-gray-900 dark:text-white">Activity</h2>
              <ul role="list" class="mt-6 space-y-6">
                {activity.map((activityItem, activityItemIdx) => (
                  <li key={activityItem.id} class="relative flex gap-x-4">
                    <div
                      class={classNames(
                        activityItemIdx === activity.length - 1 ? 'h-6' : '-bottom-6',
                        'absolute top-0 left-0 flex w-6 justify-center'
                      )}
                    >
                      <div class="w-px bg-gray-200 dark:bg-white/10" />
                    </div>
                    {activityItem.type === 'commented' ? (
                      <>
                        <img
                          alt=""
                          src={activityItem.person.imageUrl}
                          class="relative mt-3 size-6 flex-none rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                        />
                        <div class="flex-auto rounded-md p-3 ring-1 ring-gray-200 ring-inset dark:ring-white/10">
                          <div class="flex justify-between gap-x-4">
                            <div class="py-0.5 text-xs/5 text-gray-500 dark:text-gray-400">
                              <span class="font-medium text-gray-900 dark:text-white">
                                {activityItem.person.name}
                              </span>{' '}
                              commented
                            </div>
                            <time
                              dateTime={activityItem.dateTime}
                              class="flex-none py-0.5 text-xs/5 text-gray-500 dark:text-gray-400"
                            >
                              {activityItem.date}
                            </time>
                          </div>
                          <p class="text-sm/6 text-gray-500 dark:text-gray-400">
                            {activityItem.comment}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <div class="relative flex size-6 flex-none items-center justify-center bg-white dark:bg-gray-900">
                          {activityItem.type === 'paid' ? (
                            <CheckCircle
                              aria-hidden="true"
                              class="size-6 text-indigo-600 dark:text-indigo-500"
                            />
                          ) : (
                            <div class="size-1.5 rounded-full bg-gray-100 ring-1 ring-gray-300 dark:bg-white/10 dark:ring-white/20" />
                          )}
                        </div>
                        <p class="flex-auto py-0.5 text-xs/5 text-gray-500 dark:text-gray-400">
                          <span class="font-medium text-gray-900 dark:text-white">
                            {activityItem.person.name}
                          </span>{' '}
                          {activityItem.type} the invoice.
                        </p>
                        <time
                          dateTime={activityItem.dateTime}
                          class="flex-none py-0.5 text-xs/5 text-gray-500 dark:text-gray-400"
                        >
                          {activityItem.date}
                        </time>
                      </>
                    )}
                  </li>
                ))}
              </ul>

              <div class="mt-6 flex gap-x-3">
                <img
                  alt=""
                  src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                  class="size-6 flex-none rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                />
                <form action="#" class="relative flex-auto">
                  <div class="overflow-hidden rounded-lg pb-12 outline-1 -outline-offset-1 outline-gray-300 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-600 dark:bg-white/5 dark:outline-white/10 dark:focus-within:outline-indigo-500">
                    <label for="comment" class="sr-only">
                      Add your comment
                    </label>
                    <textarea
                      id="comment"
                      name="comment"
                      rows={2}
                      placeholder="Add your comment..."
                      class="block w-full resize-none bg-transparent px-3 py-1.5 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none sm:text-sm/6 dark:text-white dark:placeholder:text-gray-500"
                      defaultValue={''}
                    />
                  </div>

                  <div class="absolute inset-x-0 bottom-0 flex justify-between py-2 pr-2 pl-3">
                    <div class="flex items-center space-x-5">
                      <div class="flex items-center">
                        <button
                          type="button"
                          class="-m-2.5 flex size-10 items-center justify-center rounded-full text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-white"
                        >
                          <Paperclip class="size-5" />
                          <span class="sr-only">Attach a file</span>
                        </button>
                      </div>
                      <div class="flex items-center">
                        <Listbox value={selected} onChange={setSelected}>
                          <Label class="sr-only">Your mood</Label>
                          <div class="relative">
                            <ListboxButton class="relative -m-2.5 flex size-10 items-center justify-center rounded-full text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-white">
                              <span class="flex items-center justify-center">
                                {selected?.value === null ? (
                                  <span>
                                    <Smile aria-hidden="true" class="size-5 shrink-0" />
                                    <span class="sr-only">Add your mood</span>
                                  </span>
                                ) : selected ? (
                                  <span>
                                    <span
                                      class={classNames(
                                        selected.bgColor,
                                        'flex size-8 items-center justify-center rounded-full'
                                      )}
                                    >
                                      <selected.icon
                                        aria-hidden="true"
                                        class="size-5 shrink-0 text-white"
                                      />
                                    </span>
                                    <span class="sr-only">{selected.name}</span>
                                  </span>
                                ) : (
                                  <span>
                                    <Smile aria-hidden="true" class="size-5 shrink-0" />
                                    <span class="sr-only">Add your mood</span>
                                  </span>
                                )}
                              </span>
                            </ListboxButton>

                            <ListboxOptions
                              transition
                              class="absolute bottom-10 z-10 -ml-6 w-60 rounded-lg bg-white py-3 text-base shadow-sm outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:ml-auto sm:w-64 sm:text-sm dark:bg-gray-800 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                            >
                              {moods.map((mood) => (
                                <ListboxOption
                                  key={mood.value ?? 'null'}
                                  value={mood}
                                  class="relative cursor-default bg-white px-3 py-2 text-gray-900 select-none data-focus:bg-gray-100 dark:bg-transparent dark:text-white dark:data-focus:bg-white/5"
                                >
                                  <div class="flex items-center">
                                    <div
                                      class={classNames(
                                        mood.bgColor,
                                        'flex size-8 items-center justify-center rounded-full'
                                      )}
                                    >
                                      <mood.icon
                                        aria-hidden="true"
                                        class={classNames(mood.iconColor, 'size-5 shrink-0')}
                                      />
                                    </div>
                                    <span class="ml-3 block truncate font-medium">{mood.name}</span>
                                  </div>
                                </ListboxOption>
                              ))}
                            </ListboxOptions>
                          </div>
                        </Listbox>
                      </div>
                    </div>
                    <button
                      type="submit"
                      class="rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-xs inset-ring-1 inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
                    >
                      Comment
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function DetailScreensSidebar() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navigation = [
    { name: 'Projects', href: '#', current: false },
    { name: 'Deployments', href: '#', current: true },
    { name: 'Activity', href: '#', current: false },
    { name: 'Domains', href: '#', current: false },
    { name: 'Usage', href: '#', current: false },
    { name: 'Settings', href: '#', current: false },
  ];

  const teams = [
    { id: 1, name: 'Planetaria', href: '#', initial: 'P', current: false },
    { id: 2, name: 'Protocol', href: '#', initial: 'P', current: false },
    { id: 3, name: 'Tailwind Labs', href: '#', initial: 'T', current: false },
  ];

  const secondaryNavigation = [
    { name: 'Overview', href: '#', current: true },
    { name: 'Activity', href: '#', current: false },
    { name: 'Settings', href: '#', current: false },
    { name: 'Collaborators', href: '#', current: false },
    { name: 'Notifications', href: '#', current: false },
  ];

  const stats = [
    { name: 'Number of deploys', value: '405' },
    { name: 'Average deploy time', value: '3.65', unit: 'mins' },
    { name: 'Number of servers', value: '3' },
    { name: 'Success rate', value: '98.5%' },
  ];

  const statuses = {
    Completed: 'text-green-500 bg-green-500/10 dark:text-green-400 dark:bg-green-400/10',
    Error: 'text-rose-500 bg-rose-500/10 dark:text-rose-400 dark:bg-rose-400/10',
  };

  const activityItems = [
    {
      user: {
        name: 'Michael Foster',
        imageUrl:
          'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      commit: '2d89f0c8',
      branch: 'main',
      status: 'Completed',
      duration: '25s',
      date: '45 minutes ago',
      dateTime: '2023-01-23T11:00',
    },
    {
      user: {
        name: 'Lindsay Walton',
        imageUrl:
          'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      commit: '249df660',
      branch: 'main',
      status: 'Completed',
      duration: '1m 32s',
      date: '3 hours ago',
      dateTime: '2023-01-23T09:00',
    },
    {
      user: {
        name: 'Courtney Henry',
        imageUrl:
          'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      commit: '11464223',
      branch: 'main',
      status: 'Error',
      duration: '1m 4s',
      date: '12 hours ago',
      dateTime: '2023-01-23T00:00',
    },
    {
      user: {
        name: 'Courtney Henry',
        imageUrl:
          'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      commit: 'dad28e95',
      branch: 'main',
      status: 'Completed',
      duration: '2m 15s',
      date: '2 days ago',
      dateTime: '2023-01-21T13:00',
    },
    {
      user: {
        name: 'Michael Foster',
        imageUrl:
          'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      },
      commit: '624bc94c',
      branch: 'main',
      status: 'Completed',
      duration: '1m 12s',
      date: '5 days ago',
      dateTime: '2023-01-18T12:34',
    },
  ];

  function classNames(...classes: (string | boolean | undefined)[]) {
    return classes.filter(Boolean).join(' ');
  }

  return (
    <div class="bg-white dark:bg-gray-900 min-h-0">
      <Dialog open={sidebarOpen} onClose={setSidebarOpen} class="relative z-50 xl:hidden">
        <Transition show={sidebarOpen}>
          <DialogBackdrop
            transition
            class="fixed inset-0 bg-gray-900/80 transition-opacity duration-300 ease-linear data-[closed]:opacity-0"
          />

          <div class="fixed inset-0 flex">
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
                    <X class="size-6 text-white" />
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
                              <FileText
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
                      <div class="text-xs/6 font-semibold text-gray-400">Your teams</div>
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
                        class={classNames(
                          item.current
                            ? 'bg-gray-100 text-indigo-600 dark:bg-white/5 dark:text-white'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white',
                          'group flex gap-x-3 rounded-md p-2 text-sm/6 font-semibold'
                        )}
                      >
                        <FileText
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
              <svg
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 size-5 self-center text-gray-400 dark:text-gray-500"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fill-rule="evenodd"
                  d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                  clip-rule="evenodd"
                />
              </svg>
            </form>
          </div>
        </div>

        <main>
          <header>
            <nav class="flex overflow-x-auto border-b border-gray-200 py-4 dark:border-white/10">
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

            <div class="flex flex-col items-start justify-between gap-x-8 gap-y-4 bg-gray-50 px-4 py-4 sm:flex-row sm:items-center sm:px-6 lg:px-8 dark:bg-gray-700/10">
              <div>
                <div class="flex items-center gap-x-3">
                  <div class="flex-none rounded-full bg-green-500/10 p-1 text-green-500 dark:bg-green-400/10 dark:text-green-400">
                    <div class="size-2 rounded-full bg-current" />
                  </div>
                  <h1 class="flex gap-x-3 text-base/7">
                    <span class="font-semibold text-gray-900 dark:text-white">Planetaria</span>
                    <span class="text-gray-400 dark:text-gray-600">/</span>
                    <span class="font-semibold text-gray-900 dark:text-white">mobile-api</span>
                  </h1>
                </div>
                <p class="mt-2 text-xs/6 text-gray-500 dark:text-gray-400">
                  Deploys from GitHub via main branch
                </p>
              </div>
              <div class="order-first flex-none rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-500 ring-1 ring-indigo-200 ring-inset sm:order-0 dark:bg-indigo-400/10 dark:text-indigo-400 dark:ring-indigo-400/30">
                Production
              </div>
            </div>

            <div class="grid grid-cols-1 bg-gray-50 sm:grid-cols-2 lg:grid-cols-4 dark:bg-gray-700/10">
              {stats.map((stat, statIdx) => (
                <div
                  key={stat.name}
                  class={classNames(
                    statIdx % 2 === 1 ? 'sm:border-l' : statIdx === 2 ? 'lg:border-l' : '',
                    'border-t border-gray-200/50 px-4 py-6 sm:px-6 lg:px-8 dark:border-white/5'
                  )}
                >
                  <p class="text-sm/6 font-medium text-gray-500 dark:text-gray-400">{stat.name}</p>
                  <p class="mt-2 flex items-baseline gap-x-2">
                    <span class="text-4xl font-semibold tracking-tight text-gray-900 dark:text-white">
                      {stat.value}
                    </span>
                    {stat.unit ? (
                      <span class="text-sm text-gray-500 dark:text-gray-400">{stat.unit}</span>
                    ) : null}
                  </p>
                </div>
              ))}
            </div>
          </header>

          <div class="border-t border-gray-200 pt-11 dark:border-white/10">
            <h2 class="px-4 text-base/7 font-semibold text-gray-900 sm:px-6 lg:px-8 dark:text-white">
              Latest activity
            </h2>
            <table class="mt-6 w-full text-left whitespace-nowrap">
              <colgroup>
                <col class="w-full sm:w-4/12" />
                <col class="lg:w-4/12" />
                <col class="lg:w-2/12" />
                <col class="lg:w-1/12" />
                <col class="lg:w-1/12" />
              </colgroup>
              <thead class="border-b border-gray-200 text-sm/6 text-gray-900 dark:border-white/10 dark:text-white">
                <tr>
                  <th scope="col" class="py-2 pr-8 pl-4 font-semibold sm:pl-6 lg:pl-8">
                    User
                  </th>
                  <th scope="col" class="hidden py-2 pr-8 pl-0 font-semibold sm:table-cell">
                    Commit
                  </th>
                  <th
                    scope="col"
                    class="py-2 pr-4 pl-0 text-right font-semibold sm:pr-8 sm:text-left lg:pr-20"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    class="hidden py-2 pr-8 pl-0 font-semibold md:table-cell lg:pr-20"
                  >
                    Duration
                  </th>
                  <th
                    scope="col"
                    class="hidden py-2 pr-4 pl-0 text-right font-semibold sm:table-cell sm:pr-6 lg:pr-8"
                  >
                    Deployed at
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-white/5">
                {activityItems.map((item) => (
                  <tr key={item.commit}>
                    <td class="py-4 pr-8 pl-4 sm:pl-6 lg:pl-8">
                      <div class="flex items-center gap-x-4">
                        <img
                          alt=""
                          src={item.user.imageUrl}
                          class="size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                        />
                        <div class="truncate text-sm/6 font-medium text-gray-900 dark:text-white">
                          {item.user.name}
                        </div>
                      </div>
                    </td>
                    <td class="hidden py-4 pr-4 pl-0 sm:table-cell sm:pr-8">
                      <div class="flex gap-x-3">
                        <div class="font-mono text-sm/6 text-gray-500 dark:text-gray-400">
                          {item.commit}
                        </div>
                        <span class="inline-flex items-center rounded-md bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 ring-1 ring-gray-300 ring-inset dark:bg-gray-400/10 dark:text-gray-400 dark:ring-gray-400/20">
                          {item.branch}
                        </span>
                      </div>
                    </td>
                    <td class="py-4 pr-4 pl-0 text-sm/6 sm:pr-8 lg:pr-20">
                      <div class="flex items-center justify-end gap-x-2 sm:justify-start">
                        <time
                          dateTime={item.dateTime}
                          class="text-gray-500 sm:hidden dark:text-gray-400"
                        >
                          {item.date}
                        </time>
                        <div
                          class={classNames(
                            statuses[item.status as keyof typeof statuses],
                            'flex-none rounded-full p-1'
                          )}
                        >
                          <div class="size-1.5 rounded-full bg-current" />
                        </div>
                        <div class="hidden text-gray-900 sm:block dark:text-white">
                          {item.status}
                        </div>
                      </div>
                    </td>
                    <td class="hidden py-4 pr-8 pl-0 text-sm/6 text-gray-500 md:table-cell lg:pr-20 dark:text-gray-400">
                      {item.duration}
                    </td>
                    <td class="hidden py-4 pr-4 pl-0 text-right text-sm/6 text-gray-500 sm:table-cell sm:pr-6 lg:pr-8 dark:text-gray-400">
                      <time dateTime={item.dateTime}>{item.date}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}

export function DetailScreensDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Detail screen — Sidebar layout</h3>
        <div class="page-preview rounded-xl border border-surface-border overflow-auto">
          <DetailScreensSidebar />
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Detail screen — Stacked layout</h3>
        <div class="page-preview rounded-xl border border-surface-border overflow-auto">
          <DetailScreensStacked />
        </div>
      </div>
    </div>
  );
}
