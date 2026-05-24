import { ChevronLeft, ChevronRight } from 'lucide-preact';

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
      { date: '2022-03-07' },
      { date: '2022-03-08' },
      { date: '2022-03-09' },
      { date: '2022-03-10' },
      { date: '2022-03-11' },
      { date: '2022-03-12' },
      { date: '2022-03-13' },
    ],
  },
];

function DoubleCalendar() {
  return (
    <div>
      <div class="relative grid grid-cols-1 gap-x-14 md:grid-cols-2">
        <button
          type="button"
          class="absolute -top-1 -left-1.5 flex items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
        >
          <span class="sr-only">Previous month</span>
          <ChevronLeft aria-hidden="true" class="size-5" />
        </button>
        <button
          type="button"
          class="absolute -top-1 -right-1.5 flex items-center justify-center p-1.5 text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-white"
        >
          <span class="sr-only">Next month</span>
          <ChevronRight aria-hidden="true" class="size-5" />
        </button>
        {months.map((month, monthIdx) => (
          <section key={monthIdx} class="text-center last:max-md:hidden">
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
                  class="relative bg-surface-0 py-1.5 text-text-tertiary first:rounded-tl-lg last:rounded-br-lg hover:bg-surface-1 focus:z-10 data-is-current-month:bg-surface-0 data-is-current-month:text-text-primary data-is-current-month:hover:bg-surface-1 nth-36:rounded-bl-lg nth-7:rounded-tr-lg dark:bg-surface-2/75 dark:text-text-tertiary dark:hover:bg-surface-2/25 dark:data-is-current-month:bg-surface-2 dark:data-is-current-month:text-text-tertiary dark:data-is-current-month:hover:bg-surface-2/50"
                >
                  <time
                    dateTime={day.date}
                    class="mx-auto flex size-7 items-center justify-center rounded-full in-data-is-today:bg-indigo-600 in-data-is-today:font-semibold in-data-is-today:text-white dark:in-data-is-today:bg-indigo-500"
                  >
                    {day.date.split('-').pop()?.replace(/^0/, '') ?? ''}
                  </time>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <section class="mt-12">
        <h2 class="text-base font-semibold text-text-primary dark:text-white">Upcoming events</h2>
        <ol class="mt-2 divide-y divide-surface-border text-sm/6 text-text-secondary dark:divide-white/10 dark:text-text-tertiary">
          <li class="py-4 sm:flex">
            <time dateTime="2022-01-17" class="w-28 flex-none">
              Wed, Jan 12
            </time>
            <p class="mt-2 flex-auto sm:mt-0">Nothing on today's schedule</p>
          </li>
          <li class="py-4 sm:flex">
            <time dateTime="2022-01-19" class="w-28 flex-none">
              Thu, Jan 13
            </time>
            <p class="mt-2 flex-auto font-semibold text-text-primary sm:mt-0 dark:text-white">
              View house with real estate agent
            </p>
            <p class="flex-none sm:ml-6">
              <time dateTime="2022-01-13T14:30">2:30 PM</time> -{' '}
              <time dateTime="2022-01-13T16:30">4:30 PM</time>
            </p>
          </li>
          <li class="py-4 sm:flex">
            <time dateTime="2022-01-20" class="w-28 flex-none">
              Fri, Jan 14
            </time>
            <p class="mt-2 flex-auto font-semibold text-text-primary sm:mt-0 dark:text-white">
              Meeting with bank manager
            </p>
            <p class="flex-none sm:ml-6">All day</p>
          </li>
          <li class="py-4 sm:flex">
            <time dateTime="2022-01-18" class="w-28 flex-none">
              Mon, Jan 17
            </time>
            <p class="mt-2 flex-auto font-semibold text-text-primary sm:mt-0 dark:text-white">
              Sign paperwork at lawyers
            </p>
            <p class="flex-none sm:ml-6">
              <time dateTime="2022-01-17T10:00">10:00 AM</time> -{' '}
              <time dateTime="2022-01-17T10:15">10:15 AM</time>
            </p>
          </li>
        </ol>
      </section>
    </div>
  );
}

export function CalendarsDemo() {
  return (
    <div class="space-y-12">
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Double Calendar
        </h3>
        <DoubleCalendar />
      </section>
    </div>
  );
}
