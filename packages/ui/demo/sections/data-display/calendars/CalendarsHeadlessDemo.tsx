import { useState } from 'preact/hooks';
import { Menu, MenuButton, MenuItem, MenuItems } from '../../../../src/mod.ts';
import {
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Calendar,
  MapPin,
  ChevronDown,
  Clock,
} from 'lucide-preact';

function SmallWithMeetings() {
  const meetings = [
    {
      id: 1,
      date: 'January 10th, 2022',
      time: '5:00 PM',
      datetime: '2022-01-10T17:00',
      name: 'Leslie Alexander',
      imageUrl:
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      location: 'Starbucks',
    },
    {
      id: 2,
      date: 'January 12th, 2022',
      time: '3:00 PM',
      datetime: '2022-01-12T15:00',
      name: 'Michael Foster',
      imageUrl:
        'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      location: 'Tim Hortons',
    },
    {
      id: 3,
      date: 'January 12th, 2022',
      time: '5:00 PM',
      datetime: '2022-01-12T17:00',
      name: 'Dries Vincent',
      imageUrl:
        'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      location: 'Costa Coffee at Braehead',
    },
    {
      id: 4,
      date: 'January 14th, 2022',
      time: '10:00 AM',
      datetime: '2022-01-14T10:00',
      name: 'Lindsay Walton',
      imageUrl:
        'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      location: 'Silverburn',
    },
    {
      id: 5,
      date: 'January 14th, 2022',
      time: '12:00 PM',
      datetime: '2022-01-14T12:00',
      name: 'Courtney Henry',
      imageUrl:
        'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      location: 'The Glasgow Green',
    },
  ];
  const days = [
    { date: '2021-12-27' },
    { date: '2021-12-28' },
    { date: '2021-12-29' },
    { date: '2021-12-30' },
    { date: '2021-12-31' },
    { date: '2022-01-01', isCurrentMonth: true },
    { date: '2022-01-02', isCurrentMonth: true },
    { date: '2022-01-03', isCurrentMonth: true },
    { date: '2022-01-04', isCurrentMonth: true },
    { date: '2022-01-05', isCurrentMonth: true },
    { date: '2022-01-06', isCurrentMonth: true },
    { date: '2022-01-07', isCurrentMonth: true },
    { date: '2022-01-08', isCurrentMonth: true },
    { date: '2022-01-09', isCurrentMonth: true },
    { date: '2022-01-10', isCurrentMonth: true },
    { date: '2022-01-11', isCurrentMonth: true },
    { date: '2022-01-12', isCurrentMonth: true, isToday: true },
    { date: '2022-01-13', isCurrentMonth: true },
    { date: '2022-01-14', isCurrentMonth: true },
    { date: '2022-01-15', isCurrentMonth: true },
    { date: '2022-01-16', isCurrentMonth: true },
    { date: '2022-01-17', isCurrentMonth: true },
    { date: '2022-01-18', isCurrentMonth: true },
    { date: '2022-01-19', isCurrentMonth: true },
    { date: '2022-01-20', isCurrentMonth: true },
    { date: '2022-01-21', isCurrentMonth: true },
    { date: '2022-01-22', isCurrentMonth: true, isSelected: true },
    { date: '2022-01-23', isCurrentMonth: true },
    { date: '2022-01-24', isCurrentMonth: true },
    { date: '2022-01-25', isCurrentMonth: true },
    { date: '2022-01-26', isCurrentMonth: true },
    { date: '2022-01-27', isCurrentMonth: true },
    { date: '2022-01-28', isCurrentMonth: true },
    { date: '2022-01-29', isCurrentMonth: true },
    { date: '2022-01-30', isCurrentMonth: true },
    { date: '2022-01-31', isCurrentMonth: true },
    { date: '2022-02-01' },
    { date: '2022-02-02' },
    { date: '2022-02-03' },
    { date: '2022-02-04' },
    { date: '2022-02-05' },
    { date: '2022-02-06' },
  ];

  return (
    <div>
      <div class="lg:grid lg:grid-cols-12 lg:gap-x-16">
        <div class="mt-10 text-center lg:col-start-8 lg:col-end-13 lg:row-start-1 lg:mt-9 xl:col-start-9">
          <div class="flex items-center text-text-primary">
            <button
              type="button"
              class="-m-1.5 flex flex-none items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
            >
              <span class="sr-only">Previous month</span>
              <ChevronLeft aria-hidden="true" class="size-5" />
            </button>
            <div class="flex-auto text-sm font-semibold">January</div>
            <button
              type="button"
              class="-m-1.5 flex flex-none items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
            >
              <span class="sr-only">Next month</span>
              <ChevronRight aria-hidden="true" class="size-5" />
            </button>
          </div>
          <div class="mt-6 grid grid-cols-7 text-xs/6 text-text-secondary dark:text-text-tertiary">
            <div>M</div>
            <div>T</div>
            <div>W</div>
            <div>T</div>
            <div>F</div>
            <div>S</div>
            <div>S</div>
          </div>
          <div class="isolate mt-2 grid grid-cols-7 gap-px rounded-lg bg-surface-border text-sm shadow-sm ring-1 ring-surface-border dark:bg-white/15 dark:shadow-none dark:ring-white/15">
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                data-is-today={day.isToday ? '' : undefined}
                data-is-selected={day.isSelected ? '' : undefined}
                data-is-current-month={day.isCurrentMonth ? '' : undefined}
                class="py-1.5 not-data-is-current-month:bg-surface-1 not-data-is-selected:not-data-is-current-month:not-data-is-today:text-text-tertiary first:rounded-tl-lg last:rounded-br-lg hover:bg-surface-2 focus:z-10 data-is-current-month:bg-surface-0 not-data-is-selected:data-is-current-month:not-data-is-today:text-text-primary data-is-current-month:hover:bg-surface-1 data-is-selected:font-semibold data-is-selected:text-white data-is-today:font-semibold data-is-today:not-data-is-selected:text-accent-600 nth-36:rounded-bl-lg nth-7:rounded-tr-lg dark:not-data-is-current-month:bg-surface-2/75 dark:not-data-is-selected:not-data-is-current-month:not-data-is-today:text-text-tertiary dark:hover:bg-surface-2/25 dark:data-is-current-month:bg-surface-2/90 dark:not-data-is-selected:data-is-current-month:not-data-is-today:text-white dark:data-is-current-month:hover:bg-surface-2/50 dark:data-is-selected:text-text-primary dark:data-is-today:not-data-is-selected:text-accent-400"
              >
                <time
                  dateTime={day.date}
                  class="mx-auto flex size-7 items-center justify-center rounded-full in-data-is-selected:not-in-data-is-today:bg-text-primary in-data-is-selected:in-data-is-today:bg-accent-600 dark:in-data-is-selected:not-in-data-is-today:bg-white dark:in-data-is-selected:in-data-is-today:bg-accent-500"
                >
                  {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                </time>
              </button>
            ))}
          </div>
          <button
            type="button"
            class="mt-8 w-full rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-500"
          >
            Add event
          </button>
        </div>
        <ol class="mt-4 divide-y divide-surface-border text-sm/6 lg:col-span-7 xl:col-span-8 dark:divide-white/10">
          {meetings.map((meeting) => (
            <li key={meeting.id} class="relative flex gap-x-6 py-6 xl:static">
              <img
                alt=""
                src={meeting.imageUrl}
                class="size-14 flex-none rounded-full dark:outline dark:-outline-offset-1 dark:outline-white/10"
              />
              <div class="flex-auto">
                <h3 class="pr-10 font-semibold text-text-primary xl:pr-0 dark:text-white">
                  {meeting.name}
                </h3>
                <dl class="mt-2 flex flex-col text-text-secondary xl:flex-row dark:text-text-tertiary">
                  <div class="flex items-start gap-x-3">
                    <dt class="mt-0.5">
                      <span class="sr-only">Date</span>
                      <Calendar
                        aria-hidden="true"
                        class="size-5 text-text-tertiary dark:text-text-tertiary"
                      />
                    </dt>
                    <dd>
                      <time dateTime={meeting.datetime}>
                        {meeting.date} at {meeting.time}
                      </time>
                    </dd>
                  </div>
                  <div class="mt-2 flex items-start gap-x-3 xl:mt-0 xl:ml-3.5 xl:border-l xl:border-surface-border xl:pl-3.5 dark:xl:border-white/50">
                    <dt class="mt-0.5">
                      <span class="sr-only">Location</span>
                      <MapPin
                        aria-hidden="true"
                        class="size-5 text-text-tertiary dark:text-text-tertiary"
                      />
                    </dt>
                    <dd>{meeting.location}</dd>
                  </div>
                </dl>
              </div>
              <Menu
                as="div"
                class="absolute top-6 right-0 xl:relative xl:top-auto xl:right-auto xl:self-center"
              >
                <MenuButton class="relative flex items-center rounded-full text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white">
                  <span class="absolute -inset-2" />
                  <span class="sr-only">Open options</span>
                  <EllipsisVertical aria-hidden="true" class="size-5" />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-36 origin-top-right rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                >
                  <div class="py-1">
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                      >
                        Edit
                      </a>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                      >
                        Cancel
                      </a>
                    </MenuItem>
                  </div>
                </MenuItems>
              </Menu>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function MonthView() {
  const meetings = [
    {
      id: 1,
      name: 'Leslie Alexander',
      imageUrl:
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      start: '1:00 PM',
      startDatetime: '2022-01-21T13:00',
      end: '2:30 PM',
      endDatetime: '2022-01-21T14:30',
    },
    {
      id: 2,
      name: 'Michael Foster',
      imageUrl:
        'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      start: '3:00 PM',
      startDatetime: '2022-01-21T15:00',
      end: '4:30 PM',
      endDatetime: '2022-01-21T16:30',
    },
    {
      id: 3,
      name: 'Dries Vincent',
      imageUrl:
        'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      start: '5:00 PM',
      startDatetime: '2022-01-21T17:00',
      end: '6:30 PM',
      endDatetime: '2022-01-21T18:30',
    },
    {
      id: 4,
      name: 'Lindsay Walton',
      imageUrl:
        'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      start: '7:00 PM',
      startDatetime: '2022-01-21T19:00',
      end: '8:30 PM',
      endDatetime: '2022-01-21T20:30',
    },
    {
      id: 5,
      name: 'Courtney Henry',
      imageUrl:
        'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
      start: '9:00 PM',
      startDatetime: '2022-01-21T21:00',
      end: '10:30 PM',
      endDatetime: '2022-01-21T22:30',
    },
  ];
  const days = [
    { date: '2021-12-27' },
    { date: '2021-12-28' },
    { date: '2021-12-29' },
    { date: '2021-12-30' },
    { date: '2021-12-31' },
    { date: '2022-01-01', isCurrentMonth: true },
    { date: '2022-01-02', isCurrentMonth: true },
    { date: '2022-01-03', isCurrentMonth: true },
    { date: '2022-01-04', isCurrentMonth: true },
    { date: '2022-01-05', isCurrentMonth: true },
    { date: '2022-01-06', isCurrentMonth: true },
    { date: '2022-01-07', isCurrentMonth: true },
    { date: '2022-01-08', isCurrentMonth: true },
    { date: '2022-01-09', isCurrentMonth: true },
    { date: '2022-01-10', isCurrentMonth: true },
    { date: '2022-01-11', isCurrentMonth: true },
    { date: '2022-01-12', isCurrentMonth: true, isToday: true },
    { date: '2022-01-13', isCurrentMonth: true },
    { date: '2022-01-14', isCurrentMonth: true },
    { date: '2022-01-15', isCurrentMonth: true },
    { date: '2022-01-16', isCurrentMonth: true },
    { date: '2022-01-17', isCurrentMonth: true },
    { date: '2022-01-18', isCurrentMonth: true },
    { date: '2022-01-19', isCurrentMonth: true },
    { date: '2022-01-20', isCurrentMonth: true },
    { date: '2022-01-21', isCurrentMonth: true, isSelected: true },
    { date: '2022-01-22', isCurrentMonth: true },
    { date: '2022-01-23', isCurrentMonth: true },
    { date: '2022-01-24', isCurrentMonth: true },
    { date: '2022-01-25', isCurrentMonth: true },
    { date: '2022-01-26', isCurrentMonth: true },
    { date: '2022-01-27', isCurrentMonth: true },
    { date: '2022-01-28', isCurrentMonth: true },
    { date: '2022-01-29', isCurrentMonth: true },
    { date: '2022-01-30', isCurrentMonth: true },
    { date: '2022-01-31', isCurrentMonth: true },
    { date: '2022-02-01' },
    { date: '2022-02-02' },
    { date: '2022-02-03' },
    { date: '2022-02-04' },
    { date: '2022-02-05' },
    { date: '2022-02-06' },
  ];

  return (
    <div class="md:grid md:grid-cols-2 md:divide-x md:divide-surface-border dark:md:divide-white/10">
      <div class="md:pr-14">
        <div class="flex items-center">
          <h2 class="flex-auto text-sm font-semibold text-text-primary dark:text-white">
            January 2022
          </h2>
          <button
            type="button"
            class="-my-1.5 flex flex-none items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
          >
            <span class="sr-only">Previous month</span>
            <ChevronLeft aria-hidden="true" class="size-5" />
          </button>
          <button
            type="button"
            class="-my-1.5 -mr-1.5 ml-2 flex flex-none items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
          >
            <span class="sr-only">Next month</span>
            <ChevronRight aria-hidden="true" class="size-5" />
          </button>
        </div>
        <div class="mt-10 grid grid-cols-7 text-center text-xs/6 text-text-secondary dark:text-text-tertiary">
          <div>M</div>
          <div>T</div>
          <div>W</div>
          <div>T</div>
          <div>F</div>
          <div>S</div>
          <div>S</div>
        </div>
        <div class="mt-2 grid grid-cols-7 text-sm">
          {days.map((day, dayIdx) => (
            <div
              key={day.date}
              data-first-line={dayIdx <= 6 ? '' : undefined}
              class="py-2 not-data-first-line:border-t not-data-first-line:border-surface-border dark:not-data-first-line:border-white/10"
            >
              <button
                type="button"
                data-is-today={day.isToday ? '' : undefined}
                data-is-selected={day.isSelected ? '' : undefined}
                data-is-current-month={day.isCurrentMonth ? '' : undefined}
                class="mx-auto flex size-8 items-center justify-center rounded-full not-data-is-selected:not-data-is-today:not-data-is-current-month:text-text-tertiary not-data-is-selected:hover:bg-surface-2 not-data-is-selected:not-data-is-today:data-is-current-month:text-text-primary data-is-selected:font-semibold data-is-selected:text-white data-is-selected:not-data-is-today:bg-text-primary data-is-today:font-semibold not-data-is-selected:data-is-today:text-accent-600 data-is-selected:data-is-today:bg-accent-600 dark:not-data-is-selected:not-data-is-today:not-data-is-current-month:text-text-tertiary dark:not-data-is-selected:hover:bg-white/10 dark:not-data-is-selected:not-data-is-today:data-is-current-month:text-white dark:data-is-selected:not-data-is-today:bg-white dark:data-is-selected:not-data-is-today:text-text-primary dark:not-data-is-selected:data-is-today:text-accent-400 dark:data-is-selected:data-is-today:bg-accent-500"
              >
                <time dateTime={day.date}>
                  {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                </time>
              </button>
            </div>
          ))}
        </div>
      </div>
      <section class="mt-12 md:mt-0 md:pl-14">
        <h2 class="text-base font-semibold text-text-primary dark:text-white">
          Schedule for <time dateTime="2022-01-21">January 21, 2022</time>
        </h2>
        <ol class="mt-4 flex flex-col gap-y-1 text-sm/6 text-text-secondary dark:text-text-tertiary">
          {meetings.map((meeting) => (
            <li
              key={meeting.id}
              class="group flex items-center gap-x-4 rounded-xl px-4 py-2 focus-within:bg-surface-2 hover:bg-surface-2 dark:focus-within:bg-white/5 dark:hover:bg-white/5"
            >
              <img
                alt=""
                src={meeting.imageUrl}
                class="size-10 flex-none rounded-full dark:outline dark:-outline-offset-1 dark:outline-white/10"
              />
              <div class="flex-auto">
                <p class="text-text-primary dark:text-white">{meeting.name}</p>
                <p class="mt-0.5">
                  <time dateTime={meeting.startDatetime}>{meeting.start}</time> -{' '}
                  <time dateTime={meeting.endDatetime}>{meeting.end}</time>
                </p>
              </div>
              <Menu
                as="div"
                class="relative opacity-0 group-hover:opacity-100 focus-within:opacity-100"
              >
                <MenuButton class="relative flex items-center rounded-full text-text-tertiary outline-offset-6 hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white">
                  <span class="absolute -inset-2" />
                  <span class="sr-only">Open options</span>
                  <EllipsisVertical aria-hidden="true" class="size-6" />
                </MenuButton>

                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-36 origin-top-right rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10"
                >
                  <div class="py-1">
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                      >
                        Edit
                      </a>
                    </MenuItem>
                    <MenuItem>
                      <a
                        href="#"
                        class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                      >
                        Cancel
                      </a>
                    </MenuItem>
                  </div>
                </MenuItems>
              </Menu>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function WeekView() {
  const events = [
    { id: 1, name: 'Maple syrup museum', time: '3PM', datetime: '2022-01-15T09:00', href: '#' },
    { id: 2, name: 'Hockey game', time: '7PM', datetime: '2022-01-22T19:00', href: '#' },
  ];
  const days = [
    { date: '2021-12-27', events: [] },
    { date: '2021-12-28', events: [] },
    { date: '2021-12-29', events: [] },
    { date: '2021-12-30', events: [] },
    { date: '2021-12-31', events: [] },
    { date: '2022-01-01', isCurrentMonth: true, events: [] },
    { date: '2022-01-02', isCurrentMonth: true, events: [] },
    {
      date: '2022-01-03',
      isCurrentMonth: true,
      events: [
        { id: 1, name: 'Design review', time: '10AM', datetime: '2022-01-03T10:00', href: '#' },
        { id: 2, name: 'Sales meeting', time: '2PM', datetime: '2022-01-03T14:00', href: '#' },
      ],
    },
    { date: '2022-01-04', isCurrentMonth: true, events: [] },
    { date: '2022-01-05', isCurrentMonth: true, events: [] },
    { date: '2022-01-06', isCurrentMonth: true, events: [] },
    {
      date: '2022-01-07',
      isCurrentMonth: true,
      events: [{ id: 3, name: 'Date night', time: '6PM', datetime: '2022-01-08T18:00', href: '#' }],
    },
    { date: '2022-01-08', isCurrentMonth: true, events: [] },
    { date: '2022-01-09', isCurrentMonth: true, events: [] },
    { date: '2022-01-10', isCurrentMonth: true, events: [] },
    { date: '2022-01-11', isCurrentMonth: true, events: [] },
    {
      date: '2022-01-12',
      isCurrentMonth: true,
      isToday: true,
      events: [
        {
          id: 6,
          name: "Sam's birthday party",
          time: '2PM',
          datetime: '2022-01-25T14:00',
          href: '#',
        },
      ],
    },
    { date: '2022-01-13', isCurrentMonth: true, events: [] },
    { date: '2022-01-14', isCurrentMonth: true, events: [] },
    { date: '2022-01-15', isCurrentMonth: true, events: [] },
    { date: '2022-01-16', isCurrentMonth: true, events: [] },
    { date: '2022-01-17', isCurrentMonth: true, events: [] },
    { date: '2022-01-18', isCurrentMonth: true, events: [] },
    { date: '2022-01-19', isCurrentMonth: true, events: [] },
    { date: '2022-01-20', isCurrentMonth: true, events: [] },
    { date: '2022-01-21', isCurrentMonth: true, events: [] },
    {
      date: '2022-01-22',
      isCurrentMonth: true,
      isSelected: true,
      events: [
        { id: 4, name: 'Maple syrup museum', time: '3PM', datetime: '2022-01-22T15:00', href: '#' },
        { id: 5, name: 'Hockey game', time: '7PM', datetime: '2022-01-22T19:00', href: '#' },
      ],
    },
    { date: '2022-01-23', isCurrentMonth: true, events: [] },
    { date: '2022-01-24', isCurrentMonth: true, events: [] },
    { date: '2022-01-25', isCurrentMonth: true, events: [] },
    { date: '2022-01-26', isCurrentMonth: true, events: [] },
    { date: '2022-01-27', isCurrentMonth: true, events: [] },
    { date: '2022-01-28', isCurrentMonth: true, events: [] },
    { date: '2022-01-29', isCurrentMonth: true, events: [] },
    { date: '2022-01-30', isCurrentMonth: true, events: [] },
    { date: '2022-01-31', isCurrentMonth: true, events: [] },
    { date: '2022-02-01', events: [] },
    { date: '2022-02-02', events: [] },
    { date: '2022-02-03', events: [] },
    {
      date: '2022-02-04',
      events: [
        {
          id: 7,
          name: 'Cinema with friends',
          time: '9PM',
          datetime: '2022-02-04T21:00',
          href: '#',
        },
      ],
    },
    { date: '2022-02-05', events: [] },
    { date: '2022-02-06', events: [] },
  ];

  return (
    <div class="lg:flex lg:h-full lg:flex-col">
      <header class="flex items-center justify-between border-b border-surface-border px-6 py-4 lg:flex-none dark:border-white/10 dark:bg-surface-2/50">
        <h1 class="text-base font-semibold text-text-primary dark:text-white">
          <time dateTime="2022-01">January 2022</time>
        </h1>
        <div class="flex items-center">
          <div class="relative flex items-center rounded-lg bg-surface-0 shadow-xs outline outline-surface-border md:items-stretch dark:bg-white/10 dark:shadow-none dark:outline-white/5">
            <button
              type="button"
              class="flex h-9 w-12 items-center justify-center rounded-l-lg pr-1 text-text-tertiary hover:text-text-secondary focus:relative md:w-9 md:pr-0 md:hover:bg-surface-1 dark:hover:text-white dark:md:hover:bg-white/10"
            >
              <span class="sr-only">Previous month</span>
              <ChevronLeft aria-hidden="true" class="size-5" />
            </button>
            <button
              type="button"
              class="hidden px-3.5 text-sm font-semibold text-text-primary hover:bg-surface-1 focus:relative md:block dark:text-white dark:hover:bg-white/10"
            >
              Today
            </button>
            <span class="relative -mx-px h-5 w-px bg-surface-border md:hidden dark:bg-white/10" />
            <button
              type="button"
              class="flex h-9 w-12 items-center justify-center rounded-r-lg pl-1 text-text-tertiary hover:text-text-secondary focus:relative md:w-9 md:pl-0 md:hover:bg-surface-1 dark:hover:text-white dark:md:hover:bg-white/10"
            >
              <span class="sr-only">Next month</span>
              <ChevronRight aria-hidden="true" class="size-5" />
            </button>
          </div>
          <div class="hidden md:ml-4 md:flex md:items-center">
            <Menu as="div" class="relative">
              <MenuButton
                type="button"
                class="flex items-center gap-x-1.5 rounded-lg bg-surface-0 px-3 py-2 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20"
              >
                Month view
                <ChevronDown
                  aria-hidden="true"
                  class="-mr-1 size-5 text-text-tertiary dark:text-text-tertiary"
                />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-3 w-36 origin-top-right overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/10"
              >
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Day view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Week view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Month view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Year view
                    </a>
                  </MenuItem>
                </div>
              </MenuItems>
            </Menu>
            <div class="ml-6 h-6 w-px bg-surface-border dark:bg-white/10" />
            <button
              type="button"
              class="ml-6 rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-500"
            >
              Add event
            </button>
          </div>
          <Menu as="div" class="relative ml-6 md:hidden">
            <MenuButton class="-mx-2 flex items-center rounded-full border border-transparent p-2 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white">
              <span class="sr-only">Open menu</span>
              <EllipsisVertical aria-hidden="true" class="size-5" />
            </MenuButton>

            <MenuItems
              transition
              class="absolute right-0 z-10 mt-3 w-36 origin-top-right divide-y divide-surface-border overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:divide-white/10 dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/10"
            >
              <div class="py-1">
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Create event
                  </a>
                </MenuItem>
              </div>
              <div class="py-1">
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Go to today
                  </a>
                </MenuItem>
              </div>
              <div class="py-1">
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Day view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Week view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Month view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Year view
                  </a>
                </MenuItem>
              </div>
            </MenuItems>
          </Menu>
        </div>
      </header>
      <div class="shadow-sm ring-1 ring-black/5 lg:flex lg:flex-auto lg:flex-col dark:shadow-none dark:ring-white/5">
        <div class="grid grid-cols-7 gap-px border-b border-surface-border bg-surface-border text-center text-xs/6 font-semibold text-text-secondary lg:flex-none dark:border-white/5 dark:bg-white/15 dark:text-text-tertiary">
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>M</span>
            <span class="sr-only sm:not-sr-only">on</span>
          </div>
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>T</span>
            <span class="sr-only sm:not-sr-only">ue</span>
          </div>
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>W</span>
            <span class="sr-only sm:not-sr-only">ed</span>
          </div>
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>T</span>
            <span class="sr-only sm:not-sr-only">hu</span>
          </div>
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>F</span>
            <span class="sr-only sm:not-sr-only">ri</span>
          </div>
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>S</span>
            <span class="sr-only sm:not-sr-only">at</span>
          </div>
          <div class="flex justify-center bg-surface-0 py-2 dark:bg-surface-2">
            <span>S</span>
            <span class="sr-only sm:not-sr-only">un</span>
          </div>
        </div>
        <div class="flex bg-surface-border text-xs/6 text-text-secondary lg:flex-auto dark:bg-white/10 dark:text-text-tertiary">
          <div class="hidden w-full lg:grid lg:grid-cols-7 lg:grid-rows-6 lg:gap-px">
            {days.map((day) => (
              <div
                key={day.date}
                data-is-today={day.isToday ? '' : undefined}
                data-is-current-month={day.isCurrentMonth ? '' : undefined}
                class="group relative bg-surface-0 px-3 py-2 text-text-tertiary data-is-current-month:bg-surface-0 dark:bg-surface-2 dark:text-text-tertiary dark:not-data-is-current-month:before:pointer-events-none dark:not-data-is-current-month:before:absolute dark:not-data-is-current-month:before:inset-0 dark:not-data-is-current-month:before:bg-surface-1/50 dark:data-is-current-month:bg-surface-2"
              >
                <time
                  dateTime={day.date}
                  class="relative group-not-data-is-current-month:opacity-75 in-data-is-today:flex in-data-is-today:size-6 in-data-is-today:items-center in-data-is-today:justify-center in-data-is-today:rounded-full in-data-is-today:bg-accent-600 in-data-is-today:font-semibold in-data-is-today:text-white dark:in-data-is-today:bg-accent-500"
                >
                  {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                </time>
                {day.events.length > 0 ? (
                  <ol class="mt-2">
                    {day.events.slice(0, 2).map((event) => (
                      <li key={event.id}>
                        <a href={event.href} class="group flex">
                          <p class="flex-auto truncate font-medium text-text-primary group-hover:text-accent-600 dark:text-white dark:group-hover:text-accent-400">
                            {event.name}
                          </p>
                          <time
                            dateTime={event.datetime}
                            class="ml-3 hidden flex-none text-text-tertiary group-hover:text-accent-600 xl:block dark:text-text-tertiary dark:group-hover:text-accent-400"
                          >
                            {event.time}
                          </time>
                        </a>
                      </li>
                    ))}
                    {day.events.length > 2 ? (
                      <li class="text-text-tertiary dark:text-text-tertiary">
                        + {day.events.length - 2} more
                      </li>
                    ) : null}
                  </ol>
                ) : null}
              </div>
            ))}
          </div>
          <div class="isolate grid w-full grid-cols-7 grid-rows-6 gap-px lg:hidden">
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                data-is-today={day.isToday ? '' : undefined}
                data-is-selected={day.isSelected ? '' : undefined}
                data-is-current-month={day.isCurrentMonth ? '' : undefined}
                class="group relative flex h-14 flex-col px-3 py-2 not-data-is-current-month:bg-surface-1 not-data-is-selected:not-data-is-current-month:not-data-is-today:text-text-tertiary hover:bg-surface-2 focus:z-10 data-is-current-month:bg-surface-0 not-data-is-selected:data-is-current-month:not-data-is-today:text-text-primary data-is-current-month:hover:bg-surface-1 data-is-selected:font-semibold data-is-selected:text-white data-is-today:font-semibold not-data-is-selected:data-is-today:text-accent-600 dark:not-data-is-current-month:bg-surface-2 dark:not-data-is-selected:not-data-is-current-month:not-data-is-today:text-text-tertiary dark:not-data-is-current-month:before:pointer-events-none dark:not-data-is-current-month:before:absolute dark:not-data-is-current-month:before:inset-0 dark:not-data-is-current-month:before:bg-surface-1/50 dark:hover:bg-surface-2/50 dark:data-is-current-month:bg-surface-2 dark:not-data-is-selected:data-is-current-month:not-data-is-today:text-white dark:data-is-current-month:hover:bg-surface-2/50 dark:not-data-is-selected:data-is-today:text-accent-400"
              >
                <time
                  dateTime={day.date}
                  class="ml-auto group-not-data-is-current-month:opacity-75 in-data-is-selected:flex in-data-is-selected:size-6 in-data-is-selected:items-center in-data-is-selected:justify-center in-data-is-selected:rounded-full in-data-is-selected:not-in-data-is-today:bg-text-primary in-data-is-selected:in-data-is-today:bg-accent-600 dark:in-data-is-selected:not-in-data-is-today:bg-white dark:in-data-is-selected:not-in-data-is-today:text-text-primary dark:in-data-is-selected:in-data-is-today:bg-accent-500"
                >
                  {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                </time>
                <span class="sr-only">{day.events.length} events</span>
                {day.events.length > 0 ? (
                  <span class="-mx-0.5 mt-auto flex flex-wrap-reverse">
                    {day.events.map((event) => (
                      <span
                        key={event.id}
                        class="mx-0.5 mb-1 size-1.5 rounded-full bg-text-tertiary dark:bg-text-tertiary"
                      />
                    ))}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div class="relative px-4 py-10 sm:px-6 lg:hidden dark:after:pointer-events-none dark:after:absolute dark:after:inset-x-0 dark:after:top-0 dark:after:h-px dark:after:bg-white/10">
        <ol class="divide-y divide-surface-border overflow-hidden rounded-lg bg-surface-0 text-sm shadow-sm outline-1 outline-black/5 dark:divide-white/10 dark:bg-surface-2/50 dark:shadow-none dark:-outline-offset-1 dark:outline-white/10">
          {events.map((event) => (
            <li
              key={event.id}
              class="group flex p-4 pr-6 focus-within:bg-surface-1 hover:bg-surface-1 dark:focus-within:bg-white/5 dark:hover:bg-white/5"
            >
              <div class="flex-auto">
                <p class="font-semibold text-text-primary dark:text-white">{event.name}</p>
                <time
                  dateTime={event.datetime}
                  class="mt-2 flex items-center text-text-secondary dark:text-text-tertiary"
                >
                  <Clock
                    aria-hidden="true"
                    class="mr-2 size-5 text-text-tertiary dark:text-text-tertiary"
                  />
                  {event.time}
                </time>
              </div>
              <a
                href={event.href}
                class="ml-6 flex-none self-center rounded-lg bg-surface-0 px-3 py-2 font-semibold text-text-primary opacity-0 shadow-xs ring-1 ring-surface-border ring-inset group-hover:opacity-100 hover:ring-text-tertiary focus:opacity-100 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20 dark:hover:ring-white/5"
              >
                Edit<span class="sr-only">, {event.name}</span>
              </a>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function DayView() {
  return (
    <div class="flex h-full flex-col">
      <header class="flex flex-none items-center justify-between border-b border-surface-border px-6 py-4 dark:border-white/10 dark:bg-surface-2/50 dark:max-md:border-white/15">
        <div>
          <h1 class="text-base font-semibold text-text-primary dark:text-white">
            <time dateTime="2022-01-22" class="sm:hidden">
              Jan 22, 2022
            </time>
            <time dateTime="2022-01-22" class="hidden sm:inline">
              January 22, 2022
            </time>
          </h1>
          <p class="mt-1 text-sm text-text-secondary dark:text-text-tertiary">Saturday</p>
        </div>
        <div class="flex items-center">
          <div class="relative flex items-center rounded-lg bg-surface-0 shadow-xs outline outline-surface-border md:items-stretch dark:bg-white/10 dark:shadow-none dark:outline-white/5">
            <button
              type="button"
              class="flex h-9 w-12 items-center justify-center rounded-l-lg pr-1 text-text-tertiary hover:text-text-secondary focus:relative md:w-9 md:pr-0 md:hover:bg-surface-1 dark:hover:text-white dark:md:hover:bg-white/10"
            >
              <span class="sr-only">Previous day</span>
              <ChevronLeft aria-hidden="true" class="size-5" />
            </button>
            <button
              type="button"
              class="hidden px-3.5 text-sm font-semibold text-text-primary hover:bg-surface-1 focus:relative md:block dark:text-white dark:hover:bg-white/10"
            >
              Today
            </button>
            <span class="relative -mx-px h-5 w-px bg-surface-border md:hidden dark:bg-white/10" />
            <button
              type="button"
              class="flex h-9 w-12 items-center justify-center rounded-r-lg pl-1 text-text-tertiary hover:text-text-secondary focus:relative md:w-9 md:pl-0 md:hover:bg-surface-1 dark:hover:text-white dark:md:hover:bg-white/10"
            >
              <span class="sr-only">Next day</span>
              <ChevronRight aria-hidden="true" class="size-5" />
            </button>
          </div>
          <div class="hidden md:ml-4 md:flex md:items-center">
            <Menu as="div" class="relative">
              <MenuButton
                type="button"
                class="flex items-center gap-x-1.5 rounded-lg bg-surface-0 px-3 py-2 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20"
              >
                Day view
                <ChevronDown aria-hidden="true" class="-mr-1 size-5 text-text-tertiary" />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-3 w-36 origin-top-right overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/10"
              >
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Day view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Week view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Month view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Year view
                    </a>
                  </MenuItem>
                </div>
              </MenuItems>
            </Menu>
            <div class="ml-6 h-6 w-px bg-surface-border dark:bg-white/10" />
            <button
              type="button"
              class="ml-6 rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-500"
            >
              Add event
            </button>
          </div>
          <div class="ml-6 md:hidden">
            <Menu as="div" class="relative">
              <MenuButton class="relative flex items-center rounded-full text-text-tertiary outline-offset-8 hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white">
                <span class="absolute -inset-2" />
                <span class="sr-only">Open menu</span>
                <EllipsisVertical aria-hidden="true" class="size-5" />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-3 w-36 origin-top-right divide-y divide-surface-border overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:divide-white/10 dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/10"
              >
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Create event
                    </a>
                  </MenuItem>
                </div>
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Go to today
                    </a>
                  </MenuItem>
                </div>
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Day view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Week view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Month view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Year view
                    </a>
                  </MenuItem>
                </div>
              </MenuItems>
            </Menu>
          </div>
        </div>
      </header>
      <div class="isolate flex flex-auto overflow-hidden bg-surface-0 dark:bg-surface-2">
        <div class="flex flex-auto flex-col overflow-auto">
          <div class="sticky top-0 z-10 grid flex-none grid-cols-7 bg-surface-0 text-xs text-text-secondary shadow-sm ring-1 ring-black/5 md:hidden dark:bg-surface-2 dark:text-text-tertiary dark:shadow-none dark:ring-white/20">
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>W</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full text-base font-semibold text-text-primary dark:text-white">
                19
              </span>
            </button>
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>T</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full text-base font-semibold text-accent-600 dark:text-accent-400">
                20
              </span>
            </button>
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>F</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full text-base font-semibold text-text-primary dark:text-white">
                21
              </span>
            </button>
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>S</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full bg-text-primary text-base font-semibold text-white dark:bg-white dark:text-text-primary">
                22
              </span>
            </button>
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>S</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full text-base font-semibold text-text-primary dark:text-white">
                23
              </span>
            </button>
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>M</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full text-base font-semibold text-text-primary dark:text-white">
                24
              </span>
            </button>
            <button type="button" class="flex flex-col items-center pt-3 pb-1.5">
              <span>T</span>
              <span class="mt-3 flex size-8 items-center justify-center rounded-full text-base font-semibold text-text-primary dark:text-white">
                25
              </span>
            </button>
          </div>
          <div class="flex w-full flex-auto">
            <div class="w-14 flex-none bg-surface-0 ring-1 ring-surface-border dark:bg-surface-2 dark:ring-white/5" />
            <div class="grid flex-auto grid-cols-1 grid-rows-1">
              <div
                style={{ gridTemplateRows: 'repeat(48, minmax(3.5rem, 1fr))' }}
                class="col-start-1 col-end-2 row-start-1 grid divide-y divide-surface-border dark:divide-white/5"
              >
                <div class="row-end-1 h-7" />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    12AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    1AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    2AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    3AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    4AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    5AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    6AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    7AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    8AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    9AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    10AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    11AM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    12PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    1PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    2PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    3PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    4PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    5PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    6PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    7PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    8PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    9PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    10PM
                  </div>
                </div>
                <div />
                <div>
                  <div class="-mt-2.5 -ml-14 w-14 pr-2 text-right text-xs/5 text-text-tertiary dark:text-text-tertiary">
                    11PM
                  </div>
                </div>
                <div />
              </div>

              <ol
                style={{ gridTemplateRows: '1.75rem repeat(288, minmax(0, 1fr)) auto' }}
                class="col-start-1 col-end-2 row-start-1 grid grid-cols-1"
              >
                <li
                  style={{ gridRow: '74 / span 12' }}
                  class="relative mt-px flex dark:before:pointer-events-none dark:before:absolute dark:before:inset-1 dark:before:z-0 dark:before:rounded-lg dark:before:bg-surface-2"
                >
                  <a
                    href="#"
                    class="group absolute inset-1 flex flex-col overflow-y-auto rounded-lg bg-blue-50 p-2 text-xs/5 hover:bg-blue-100 dark:bg-blue-600/15 dark:hover:bg-blue-600/20"
                  >
                    <p class="order-1 font-semibold text-blue-700 dark:text-blue-300">Breakfast</p>
                    <p class="text-blue-500 group-hover:text-blue-700 dark:text-blue-400 dark:group-hover:text-blue-300">
                      <time dateTime="2022-01-22T06:00">6:00 AM</time>
                    </p>
                  </a>
                </li>
                <li
                  style={{ gridRow: '92 / span 30' }}
                  class="relative mt-px flex dark:before:pointer-events-none dark:before:absolute dark:before:inset-1 dark:before:z-0 dark:before:rounded-lg dark:before:bg-surface-2"
                >
                  <a
                    href="#"
                    class="group absolute inset-1 flex flex-col overflow-y-auto rounded-lg bg-pink-50 p-2 text-xs/5 hover:bg-pink-100 dark:bg-pink-600/15 dark:hover:bg-pink-600/20"
                  >
                    <p class="order-1 font-semibold text-pink-700 dark:text-pink-300">
                      Flight to Paris
                    </p>
                    <p class="order-1 text-pink-500 group-hover:text-pink-700 dark:text-pink-400 dark:group-hover:text-pink-300">
                      John F. Kennedy International Airport
                    </p>
                    <p class="text-pink-500 group-hover:text-pink-700 dark:text-pink-400 dark:group-hover:text-pink-300">
                      <time dateTime="2022-01-22T07:30">7:30 AM</time>
                    </p>
                  </a>
                </li>
                <li
                  style={{ gridRow: '134 / span 18' }}
                  class="relative mt-px flex dark:before:pointer-events-none dark:before:absolute dark:before:inset-1 dark:before:z-0 dark:before:rounded-lg dark:before:bg-surface-2"
                >
                  <a
                    href="#"
                    class="group absolute inset-1 flex flex-col overflow-y-auto rounded-lg bg-accent-50 p-2 text-xs/5 hover:bg-accent-100 dark:bg-accent-600/15 dark:hover:bg-accent-600/20"
                  >
                    <p class="order-1 font-semibold text-accent-700 dark:text-accent-300">
                      Sightseeing
                    </p>
                    <p class="order-1 text-accent-500 group-hover:text-accent-700 dark:text-accent-400 dark:group-hover:text-accent-300">
                      Eiffel Tower
                    </p>
                    <p class="text-accent-500 group-hover:text-accent-700 dark:text-accent-400 dark:group-hover:text-accent-300">
                      <time dateTime="2022-01-22T11:00">11:00 AM</time>
                    </p>
                  </a>
                </li>
              </ol>
            </div>
          </div>
        </div>
        <div class="hidden w-1/2 max-w-md flex-none border-l border-surface-border px-8 py-10 md:block dark:border-white/10">
          <div class="flex items-center text-center text-text-primary">
            <button
              type="button"
              class="-m-1.5 flex flex-none items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
            >
              <span class="sr-only">Previous month</span>
              <ChevronLeft aria-hidden="true" class="size-5" />
            </button>
            <div class="flex-auto text-sm font-semibold">January 2022</div>
            <button
              type="button"
              class="-m-1.5 flex flex-none items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
            >
              <span class="sr-only">Next month</span>
              <ChevronRight aria-hidden="true" class="size-5" />
            </button>
          </div>
          <div class="mt-6 grid grid-cols-7 text-center text-xs/6 text-text-secondary dark:text-text-tertiary">
            <div>M</div>
            <div>T</div>
            <div>W</div>
            <div>T</div>
            <div>F</div>
            <div>S</div>
            <div>S</div>
          </div>
          <div class="isolate mt-2 grid grid-cols-7 gap-px rounded-lg bg-surface-border text-sm shadow-sm ring-1 ring-surface-border dark:bg-white/10 dark:shadow-none dark:ring-white/10">
            {[
              { date: '2021-12-27' },
              { date: '2021-12-28' },
              { date: '2021-12-29' },
              { date: '2021-12-30' },
              { date: '2021-12-31' },
              { date: '2022-01-01', isCurrentMonth: true },
              { date: '2022-01-02', isCurrentMonth: true },
              { date: '2022-01-03', isCurrentMonth: true },
              { date: '2022-01-04', isCurrentMonth: true },
              { date: '2022-01-05', isCurrentMonth: true },
              { date: '2022-01-06', isCurrentMonth: true },
              { date: '2022-01-07', isCurrentMonth: true },
              { date: '2022-01-08', isCurrentMonth: true },
              { date: '2022-01-09', isCurrentMonth: true },
              { date: '2022-01-10', isCurrentMonth: true },
              { date: '2022-01-11', isCurrentMonth: true },
              { date: '2022-01-12', isCurrentMonth: true },
              { date: '2022-01-13', isCurrentMonth: true },
              { date: '2022-01-14', isCurrentMonth: true },
              { date: '2022-01-15', isCurrentMonth: true },
              { date: '2022-01-16', isCurrentMonth: true },
              { date: '2022-01-17', isCurrentMonth: true },
              { date: '2022-01-18', isCurrentMonth: true },
              { date: '2022-01-19', isCurrentMonth: true, isToday: true },
              { date: '2022-01-20', isCurrentMonth: true },
              { date: '2022-01-21', isCurrentMonth: true },
              { date: '2022-01-22', isCurrentMonth: true, isSelected: true },
              { date: '2022-01-23', isCurrentMonth: true },
              { date: '2022-01-24', isCurrentMonth: true },
              { date: '2022-01-25', isCurrentMonth: true },
              { date: '2022-01-26', isCurrentMonth: true },
              { date: '2022-01-27', isCurrentMonth: true },
              { date: '2022-01-28', isCurrentMonth: true },
              { date: '2022-01-29', isCurrentMonth: true },
              { date: '2022-01-30', isCurrentMonth: true },
              { date: '2022-01-31', isCurrentMonth: true },
              { date: '2022-02-01' },
              { date: '2022-02-02' },
              { date: '2022-02-03' },
              { date: '2022-02-04' },
              { date: '2022-02-05' },
              { date: '2022-02-06' },
            ].map((day) => (
              <button
                key={day.date}
                type="button"
                data-is-today={day.isToday ? '' : undefined}
                data-is-selected={day.isSelected ? '' : undefined}
                data-is-current-month={day.isCurrentMonth ? '' : undefined}
                class="py-1.5 not-data-is-current-month:bg-surface-1 not-data-is-selected:not-data-is-current-month:not-data-is-today:text-text-tertiary first:rounded-tl-lg last:rounded-br-lg hover:bg-surface-2 focus:z-10 data-is-current-month:bg-surface-0 not-data-is-selected:data-is-current-month:not-data-is-today:text-text-primary data-is-current-month:hover:bg-surface-1 data-is-selected:font-semibold data-is-selected:text-white data-is-today:font-semibold data-is-today:not-data-is-selected:text-accent-600 nth-36:rounded-bl-lg nth-7:rounded-tr-lg dark:not-data-is-current-month:bg-surface-2/75 dark:not-data-is-selected:not-data-is-current-month:not-data-is-today:text-text-tertiary dark:hover:bg-surface-2/25 dark:data-is-current-month:bg-surface-2/90 dark:not-data-is-selected:data-is-current-month:not-data-is-today:text-white dark:data-is-current-month:hover:bg-surface-2/50 dark:data-is-selected:text-text-primary dark:data-is-today:not-data-is-selected:text-accent-400"
              >
                <time
                  dateTime={day.date}
                  class="mx-auto flex size-7 items-center justify-center rounded-full in-data-is-selected:not-in-data-is-today:bg-text-primary in-data-is-selected:in-data-is-today:bg-accent-600 dark:in-data-is-selected:not-in-data-is-today:bg-white dark:in-data-is-selected:in-data-is-today:bg-accent-500"
                >
                  {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                </time>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function YearView() {
  const months = [
    {
      name: 'January',
      days: [
        { date: '2021-12-27' },
        { date: '2021-12-28' },
        { date: '2021-12-29' },
        { date: '2021-12-30' },
        { date: '2021-12-31' },
        { date: '2022-01-01', isCurrentMonth: true },
        { date: '2022-01-02', isCurrentMonth: true },
        { date: '2022-01-03', isCurrentMonth: true },
        { date: '2022-01-04', isCurrentMonth: true },
        { date: '2022-01-05', isCurrentMonth: true },
        { date: '2022-01-06', isCurrentMonth: true },
        { date: '2022-01-07', isCurrentMonth: true },
        { date: '2022-01-08', isCurrentMonth: true },
        { date: '2022-01-09', isCurrentMonth: true },
        { date: '2022-01-10', isCurrentMonth: true },
        { date: '2022-01-11', isCurrentMonth: true },
        { date: '2022-01-12', isCurrentMonth: true, isToday: true },
        { date: '2022-01-13', isCurrentMonth: true },
        { date: '2022-01-14', isCurrentMonth: true },
        { date: '2022-01-15', isCurrentMonth: true },
        { date: '2022-01-16', isCurrentMonth: true },
        { date: '2022-01-17', isCurrentMonth: true },
        { date: '2022-01-18', isCurrentMonth: true },
        { date: '2022-01-19', isCurrentMonth: true },
        { date: '2022-01-20', isCurrentMonth: true },
        { date: '2022-01-21', isCurrentMonth: true },
        { date: '2022-01-22', isCurrentMonth: true },
        { date: '2022-01-23', isCurrentMonth: true },
        { date: '2022-01-24', isCurrentMonth: true },
        { date: '2022-01-25', isCurrentMonth: true },
        { date: '2022-01-26', isCurrentMonth: true },
        { date: '2022-01-27', isCurrentMonth: true },
        { date: '2022-01-28', isCurrentMonth: true },
        { date: '2022-01-29', isCurrentMonth: true },
        { date: '2022-01-30', isCurrentMonth: true },
        { date: '2022-01-31', isCurrentMonth: true },
        { date: '2022-02-01' },
        { date: '2022-02-02' },
        { date: '2022-02-03' },
        { date: '2022-02-04' },
        { date: '2022-02-05' },
        { date: '2022-02-06' },
      ],
    },
    {
      name: 'February',
      days: [
        { date: '2022-01-31' },
        { date: '2022-02-01', isCurrentMonth: true },
        { date: '2022-02-02', isCurrentMonth: true },
        { date: '2022-02-03', isCurrentMonth: true },
        { date: '2022-02-04', isCurrentMonth: true },
        { date: '2022-02-05', isCurrentMonth: true },
        { date: '2022-02-06', isCurrentMonth: true },
        { date: '2022-02-07', isCurrentMonth: true },
        { date: '2022-02-08', isCurrentMonth: true },
        { date: '2022-02-09', isCurrentMonth: true },
        { date: '2022-02-10', isCurrentMonth: true },
        { date: '2022-02-11', isCurrentMonth: true },
        { date: '2022-02-12', isCurrentMonth: true },
        { date: '2022-02-13', isCurrentMonth: true },
        { date: '2022-02-14', isCurrentMonth: true },
        { date: '2022-02-15', isCurrentMonth: true },
        { date: '2022-02-16', isCurrentMonth: true },
        { date: '2022-02-17', isCurrentMonth: true },
        { date: '2022-02-18', isCurrentMonth: true },
        { date: '2022-02-19', isCurrentMonth: true },
        { date: '2022-02-20', isCurrentMonth: true },
        { date: '2022-02-21', isCurrentMonth: true },
        { date: '2022-02-22', isCurrentMonth: true },
        { date: '2022-02-23', isCurrentMonth: true },
        { date: '2022-02-24', isCurrentMonth: true },
        { date: '2022-02-25', isCurrentMonth: true },
        { date: '2022-02-26', isCurrentMonth: true },
        { date: '2022-02-27', isCurrentMonth: true },
        { date: '2022-02-28', isCurrentMonth: true },
        { date: '2022-03-01' },
        { date: '2022-03-02' },
        { date: '2022-03-03' },
        { date: '2022-03-04' },
        { date: '2022-03-05' },
        { date: '2022-03-06' },
      ],
    },
    {
      name: 'March',
      days: [
        { date: '2022-02-28' },
        { date: '2022-03-01', isCurrentMonth: true },
        { date: '2022-03-02', isCurrentMonth: true },
        { date: '2022-03-03', isCurrentMonth: true },
        { date: '2022-03-04', isCurrentMonth: true },
        { date: '2022-03-05', isCurrentMonth: true },
        { date: '2022-03-06', isCurrentMonth: true },
        { date: '2022-03-07', isCurrentMonth: true },
        { date: '2022-03-08', isCurrentMonth: true },
        { date: '2022-03-09', isCurrentMonth: true },
        { date: '2022-03-10', isCurrentMonth: true },
        { date: '2022-03-11', isCurrentMonth: true },
        { date: '2022-03-12', isCurrentMonth: true },
        { date: '2022-03-13', isCurrentMonth: true },
        { date: '2022-03-14', isCurrentMonth: true },
        { date: '2022-03-15', isCurrentMonth: true },
        { date: '2022-03-16', isCurrentMonth: true },
        { date: '2022-03-17', isCurrentMonth: true },
        { date: '2022-03-18', isCurrentMonth: true },
        { date: '2022-03-19', isCurrentMonth: true },
        { date: '2022-03-20', isCurrentMonth: true },
        { date: '2022-03-21', isCurrentMonth: true },
        { date: '2022-03-22', isCurrentMonth: true },
        { date: '2022-03-23', isCurrentMonth: true },
        { date: '2022-03-24', isCurrentMonth: true },
        { date: '2022-03-25', isCurrentMonth: true },
        { date: '2022-03-26', isCurrentMonth: true },
        { date: '2022-03-27', isCurrentMonth: true },
        { date: '2022-03-28', isCurrentMonth: true },
        { date: '2022-03-29', isCurrentMonth: true },
        { date: '2022-03-30', isCurrentMonth: true },
        { date: '2022-03-31', isCurrentMonth: true },
        { date: '2022-04-01' },
        { date: '2022-04-02' },
        { date: '2022-04-03' },
        { date: '2022-04-04' },
        { date: '2022-04-05' },
        { date: '2022-04-06' },
      ],
    },
    {
      name: 'April',
      days: [
        { date: '2022-03-28' },
        { date: '2022-03-29' },
        { date: '2022-03-30' },
        { date: '2022-03-31' },
        { date: '2022-04-01', isCurrentMonth: true },
        { date: '2022-04-02', isCurrentMonth: true },
        { date: '2022-04-03', isCurrentMonth: true },
        { date: '2022-04-04', isCurrentMonth: true },
        { date: '2022-04-05', isCurrentMonth: true },
        { date: '2022-04-06', isCurrentMonth: true },
        { date: '2022-04-07', isCurrentMonth: true },
        { date: '2022-04-08', isCurrentMonth: true },
        { date: '2022-04-09', isCurrentMonth: true },
        { date: '2022-04-10', isCurrentMonth: true },
        { date: '2022-04-11', isCurrentMonth: true },
        { date: '2022-04-12', isCurrentMonth: true },
        { date: '2022-04-13', isCurrentMonth: true },
        { date: '2022-04-14', isCurrentMonth: true },
        { date: '2022-04-15', isCurrentMonth: true },
        { date: '2022-04-16', isCurrentMonth: true },
        { date: '2022-04-17', isCurrentMonth: true },
        { date: '2022-04-18', isCurrentMonth: true },
        { date: '2022-04-19', isCurrentMonth: true },
        { date: '2022-04-20', isCurrentMonth: true },
        { date: '2022-04-21', isCurrentMonth: true },
        { date: '2022-04-22', isCurrentMonth: true },
        { date: '2022-04-23', isCurrentMonth: true },
        { date: '2022-04-24', isCurrentMonth: true },
        { date: '2022-04-25', isCurrentMonth: true },
        { date: '2022-04-26', isCurrentMonth: true },
        { date: '2022-04-27', isCurrentMonth: true },
        { date: '2022-04-28', isCurrentMonth: true },
        { date: '2022-04-29', isCurrentMonth: true },
        { date: '2022-04-30', isCurrentMonth: true },
        { date: '2022-05-01' },
        { date: '2022-05-02' },
        { date: '2022-05-03' },
        { date: '2022-05-04' },
        { date: '2022-05-05' },
        { date: '2022-05-06' },
      ],
    },
  ];

  return (
    <div>
      <header class="flex items-center justify-between border-b border-surface-border px-6 py-4 dark:border-white/10 dark:bg-surface-2/50">
        <h1 class="text-base font-semibold text-text-primary dark:text-white">
          <time dateTime="2022">2022</time>
        </h1>
        <div class="flex items-center">
          <div class="relative flex items-center rounded-lg bg-surface-0 shadow-xs outline outline-surface-border md:items-stretch dark:bg-white/10 dark:shadow-none dark:outline-white/5">
            <button
              type="button"
              class="flex h-9 w-12 items-center justify-center rounded-l-lg pr-1 text-text-tertiary hover:text-text-secondary focus:relative md:w-9 md:pr-0 md:hover:bg-surface-1 dark:hover:text-white dark:md:hover:bg-white/10"
            >
              <span class="sr-only">Previous year</span>
              <ChevronLeft aria-hidden="true" class="size-5" />
            </button>
            <button
              type="button"
              class="hidden px-3.5 text-sm font-semibold text-text-primary hover:bg-surface-1 focus:relative md:block dark:text-white dark:hover:bg-white/10"
            >
              Today
            </button>
            <span class="relative -mx-px h-5 w-px bg-surface-border md:hidden dark:bg-white/10" />
            <button
              type="button"
              class="flex h-9 w-12 items-center justify-center rounded-r-lg pl-1 text-text-tertiary hover:text-text-secondary focus:relative md:w-9 md:pl-0 md:hover:bg-surface-1 dark:hover:text-white dark:md:hover:bg-white/10"
            >
              <span class="sr-only">Next year</span>
              <ChevronRight aria-hidden="true" class="size-5" />
            </button>
          </div>
          <div class="hidden md:ml-4 md:flex md:items-center">
            <Menu as="div" class="relative">
              <MenuButton
                type="button"
                class="flex items-center gap-x-1.5 rounded-lg bg-surface-0 px-3 py-2 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20"
              >
                Year view
                <ChevronDown aria-hidden="true" class="-mr-1 size-5 text-text-tertiary" />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-3 w-36 origin-top-right overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:shadow-none dark:-outline-offset-1 dark:outline-white/5"
              >
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Day view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Week view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Month view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Year view
                    </a>
                  </MenuItem>
                </div>
              </MenuItems>
            </Menu>
            <div class="ml-6 h-6 w-px bg-surface-border dark:bg-white/10" />
            <button
              type="button"
              class="ml-6 rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-500"
            >
              Add event
            </button>
          </div>
          <div class="ml-6 md:hidden">
            <Menu as="div" class="relative">
              <MenuButton class="relative flex items-center rounded-full text-text-tertiary outline-offset-8 hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white">
                <span class="absolute -inset-2" />
                <span class="sr-only">Open menu</span>
                <EllipsisVertical aria-hidden="true" class="size-5" />
              </MenuButton>

              <MenuItems
                transition
                class="absolute right-0 z-10 mt-3 w-36 origin-top-right divide-y divide-surface-border overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:divide-white/10 dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/5"
              >
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Create event
                    </a>
                  </MenuItem>
                </div>
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Go to today
                    </a>
                  </MenuItem>
                </div>
                <div class="py-1">
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Day view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Week view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Month view
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                    >
                      Year view
                    </a>
                  </MenuItem>
                </div>
              </MenuItems>
            </Menu>
          </div>
        </div>
      </header>
      <div class="bg-surface-0 dark:bg-surface-2">
        <div class="mx-auto grid max-w-3xl grid-cols-1 gap-x-8 gap-y-16 px-4 py-16 sm:grid-cols-2 sm:px-6 xl:max-w-none xl:grid-cols-3 xl:px-8 2xl:grid-cols-4">
          {months.map((month) => (
            <section key={month.name} class="text-center">
              <h2 class="text-sm font-semibold text-text-primary dark:text-white">{month.name}</h2>
              <div class="mt-6 grid grid-cols-7 text-xs/6 text-text-secondary dark:text-text-tertiary">
                <div>M</div>
                <div>T</div>
                <div>W</div>
                <div>T</div>
                <div>F</div>
                <div>S</div>
                <div>S</div>
              </div>
              <div class="isolate mt-2 grid grid-cols-7 gap-px rounded-lg bg-surface-border text-sm shadow-sm ring-1 ring-surface-border dark:bg-white/10 dark:shadow-none dark:ring-white/10">
                {month.days.map((day) => (
                  <button
                    key={day.date}
                    type="button"
                    data-is-today={day.isToday ? '' : undefined}
                    data-is-current-month={day.isCurrentMonth ? '' : undefined}
                    class="relative bg-surface-1 py-1.5 text-text-tertiary first:rounded-tl-lg last:rounded-br-lg hover:bg-surface-2 focus:z-10 data-is-current-month:bg-surface-0 data-is-current-month:text-text-primary data-is-current-month:hover:bg-surface-1 nth-36:rounded-bl-lg nth-7:rounded-tr-lg dark:bg-surface-2/75 dark:text-text-tertiary dark:hover:bg-surface-2/25 dark:data-is-current-month:bg-surface-2 dark:data-is-current-month:text-text-secondary dark:data-is-current-month:hover:bg-surface-2/50"
                  >
                    <time
                      dateTime={day.date}
                      class="mx-auto flex size-7 items-center justify-center rounded-full in-data-is-today:bg-accent-600 in-data-is-today:font-semibold in-data-is-today:text-white dark:in-data-is-today:bg-accent-500"
                    >
                      {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                    </time>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function BorderlessStacked() {
  const [selectedDate, setSelectedDate] = useState('2022-01-22');

  const days = [
    { date: '2022-01-16' },
    { date: '2022-01-17' },
    { date: '2022-01-18' },
    { date: '2022-01-19' },
    { date: '2022-01-20' },
    { date: '2022-01-21' },
    { date: '2022-01-22' },
  ];

  const events = [
    {
      id: 1,
      name: 'Breakfast',
      time: '6:00 AM',
      datetime: '2022-01-22T06:00',
      color: 'bg-blue-500',
    },
    {
      id: 2,
      name: 'Flight to Paris',
      time: '7:30 AM',
      datetime: '2022-01-22T07:30',
      color: 'bg-pink-500',
    },
    {
      id: 3,
      name: 'Sightseeing',
      time: '11:00 AM',
      datetime: '2022-01-22T11:00',
      color: 'bg-accent-500',
    },
  ];

  return (
    <div class="flex h-full flex-col">
      <header class="flex flex-none items-center justify-between border-b border-surface-border px-6 py-4 dark:border-white/10 dark:bg-surface-2/50">
        <div>
          <h1 class="text-base font-semibold text-text-primary dark:text-white">
            <time dateTime="2022-01-22">January 22, 2022</time>
          </h1>
          <p class="mt-1 text-sm text-text-secondary dark:text-text-tertiary">Saturday</p>
        </div>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-500 dark:bg-accent-500 dark:hover:bg-accent-400"
          >
            Add event
          </button>
          <Menu as="div" class="relative">
            <MenuButton class="flex items-center gap-x-1.5 rounded-lg bg-surface-0 px-3 py-2 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20">
              Week view
              <ChevronDown aria-hidden="true" class="-mr-1 size-5 text-text-tertiary" />
            </MenuButton>
            <MenuItems
              transition
              class="absolute right-0 z-10 mt-3 w-36 origin-top-right overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/10"
            >
              <div class="py-1">
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Day view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Week view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Month view
                  </a>
                </MenuItem>
              </div>
            </MenuItems>
          </Menu>
        </div>
      </header>

      <div class="flex flex-auto overflow-hidden">
        <div class="hidden w-48 flex-none border-r border-surface-border p-4 lg:block dark:border-white/10">
          <div class="space-y-3">
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                onClick={() => setSelectedDate(day.date)}
                class={
                  day.date === selectedDate
                    ? 'w-full rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white'
                    : 'w-full rounded-lg px-3 py-2 text-sm text-text-primary hover:bg-surface-2 dark:text-white dark:hover:bg-surface-2'
                }
              >
                <div class="text-xs opacity-80">
                  {new Date(day.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                </div>
                <div>
                  {new Date(day.date + 'T00:00').toLocaleDateString('en-US', { day: 'numeric' })}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div class="flex-auto overflow-auto p-4">
          <div class="space-y-4">
            {events.map((event) => (
              <div
                key={event.id}
                class="flex items-start gap-4 rounded-lg bg-surface-1 p-4 dark:bg-surface-2/50"
              >
                <div class={`size-3 rounded-full mt-1.5 ${event.color}`} />
                <div class="flex-auto">
                  <p class="font-semibold text-text-primary dark:text-white">{event.name}</p>
                  <p class="text-sm text-text-secondary dark:text-text-tertiary">{event.time}</p>
                </div>
                <Menu as="div" class="relative">
                  <MenuButton class="text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white">
                    <EllipsisVertical class="size-5" />
                  </MenuButton>
                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2 w-32 origin-top-right rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:opacity-0 dark:bg-surface-2 dark:outline-white/10"
                  >
                    <div class="py-1">
                      <MenuItem>
                        <a
                          href="#"
                          class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                        >
                          Edit
                        </a>
                      </MenuItem>
                      <MenuItem>
                        <a
                          href="#"
                          class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                        >
                          Delete
                        </a>
                      </MenuItem>
                    </div>
                  </MenuItems>
                </Menu>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BorderlessSideBySide() {
  const days = [
    { date: '2022-01-16' },
    { date: '2022-01-17' },
    { date: '2022-01-18' },
    { date: '2022-01-19' },
    { date: '2022-01-20' },
    { date: '2022-01-21' },
    { date: '2022-01-22' },
  ];

  return (
    <div class="flex h-full flex-col">
      <header class="flex flex-none items-center justify-between border-b border-surface-border px-6 py-4 dark:border-white/10 dark:bg-surface-2/50">
        <div>
          <h1 class="text-base font-semibold text-text-primary dark:text-white">
            <time dateTime="2022-01-22">January 22, 2022</time>
          </h1>
          <p class="mt-1 text-sm text-text-secondary dark:text-text-tertiary">Saturday</p>
        </div>
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="p-2 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
            >
              <ChevronLeft class="size-5" />
            </button>
            <button
              type="button"
              class="rounded-lg px-3 py-2 text-sm font-semibold text-text-primary hover:bg-surface-2 dark:text-white dark:hover:bg-surface-2"
            >
              Today
            </button>
            <button
              type="button"
              class="p-2 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
            >
              <ChevronRight class="size-5" />
            </button>
          </div>
          <Menu as="div" class="relative">
            <MenuButton class="flex items-center gap-x-1.5 rounded-lg bg-surface-0 px-3 py-2 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-1 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20">
              Week view
              <ChevronDown aria-hidden="true" class="-mr-1 size-5 text-text-tertiary" />
            </MenuButton>
            <MenuItems
              transition
              class="absolute right-0 z-10 mt-3 w-36 origin-top-right overflow-hidden rounded-lg bg-surface-1 shadow-lg outline-1 outline-black/5 transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:bg-surface-2 dark:-outline-offset-1 dark:outline-white/10"
            >
              <div class="py-1">
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Day view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Week view
                  </a>
                </MenuItem>
                <MenuItem>
                  <a
                    href="#"
                    class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white dark:text-text-secondary dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                  >
                    Month view
                  </a>
                </MenuItem>
              </div>
            </MenuItems>
          </Menu>
          <button
            type="button"
            class="rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-500 dark:bg-accent-500 dark:hover:bg-accent-400"
          >
            Add event
          </button>
        </div>
      </header>

      <div class="flex flex-auto overflow-hidden">
        <div class="hidden w-64 flex-none border-r border-surface-border p-4 dark:border-white/10 lg:block">
          <h3 class="text-sm font-semibold text-text-primary dark:text-white mb-4">January 2022</h3>
          <div class="grid grid-cols-7 gap-1 text-center text-xs">
            <div class="text-text-tertiary">S</div>
            <div class="text-text-tertiary">M</div>
            <div class="text-text-tertiary">T</div>
            <div class="text-text-tertiary">W</div>
            <div class="text-text-tertiary">T</div>
            <div class="text-text-tertiary">F</div>
            <div class="text-text-tertiary">S</div>
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                class="size-8 rounded-full text-text-secondary hover:bg-surface-2 dark:text-text-tertiary dark:hover:bg-surface-2"
              >
                {new Date(day.date + 'T00:00').getDate()}
              </button>
            ))}
          </div>
        </div>

        <div class="flex-auto overflow-auto p-6">
          <div class="space-y-4">
            <div class="flex items-center gap-4">
              <div class="size-3 rounded-full bg-blue-500" />
              <div class="flex-auto">
                <p class="font-semibold text-text-primary dark:text-white">Breakfast</p>
                <p class="text-sm text-text-secondary dark:text-text-tertiary">6:00 AM</p>
              </div>
            </div>
            <div class="flex items-center gap-4">
              <div class="size-3 rounded-full bg-pink-500" />
              <div class="flex-auto">
                <p class="font-semibold text-text-primary dark:text-white">Flight to Paris</p>
                <p class="text-sm text-text-secondary dark:text-text-tertiary">
                  7:30 AM - John F. Kennedy International Airport
                </p>
              </div>
            </div>
            <div class="flex items-center gap-4">
              <div class="size-3 rounded-full bg-accent-500" />
              <div class="flex-auto">
                <p class="font-semibold text-text-primary dark:text-white">Sightseeing</p>
                <p class="text-sm text-text-secondary dark:text-text-tertiary">
                  11:00 AM - Eiffel Tower
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CalendarsHeadlessDemo() {
  return (
    <div class="space-y-16">
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Small Calendar with Meetings
        </h3>
        <SmallWithMeetings />
      </section>

      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Month View with Schedule
        </h3>
        <MonthView />
      </section>

      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Week View Calendar
        </h3>
        <WeekView />
      </section>

      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Day View Calendar
        </h3>
        <DayView />
      </section>

      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Year View Calendar
        </h3>
        <YearView />
      </section>

      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Borderless Stacked Calendar
        </h3>
        <BorderlessStacked />
      </section>

      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Borderless Side by Side Calendar
        </h3>
        <BorderlessSideBySide />
      </section>
    </div>
  );
}
