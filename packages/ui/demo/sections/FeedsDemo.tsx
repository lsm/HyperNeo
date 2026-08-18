import { useState } from 'preact/hooks';
import { Check, ThumbsUp, User, CheckCircle, Circle, Smile, Paperclip } from 'lucide-preact';
import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from '../../src/mod.ts';
import { classNames } from '../../src/internal/class-names.ts';

const timeline = [
  {
    id: 1,
    content: 'Applied to',
    target: 'Front End Developer',
    href: '#',
    date: 'Sep 20',
    datetime: '2020-09-20',
    icon: User,
    iconBackground: 'bg-surface-3 dark:bg-surface-2',
  },
  {
    id: 2,
    content: 'Advanced to phone screening by',
    target: 'Bethany Blake',
    href: '#',
    date: 'Sep 22',
    datetime: '2020-09-22',
    icon: ThumbsUp,
    iconBackground: 'bg-blue-500',
  },
  {
    id: 3,
    content: 'Completed phone screening with',
    target: 'Martha Gardner',
    href: '#',
    date: 'Sep 28',
    datetime: '2020-09-28',
    icon: Check,
    iconBackground: 'bg-green-500',
  },
  {
    id: 4,
    content: 'Advanced to interview by',
    target: 'Bethany Blake',
    href: '#',
    date: 'Sep 30',
    datetime: '2020-09-30',
    icon: ThumbsUp,
    iconBackground: 'bg-blue-500',
  },
  {
    id: 5,
    content: 'Completed interview with',
    target: 'Katherine Snyder',
    href: '#',
    date: 'Oct 4',
    datetime: '2020-10-04',
    icon: Check,
    iconBackground: 'bg-green-500',
  },
];

export function SimpleWithIcons() {
  return (
    <div class="flow-root">
      <ul role="list" class="-mb-8">
        {timeline.map((event, eventIdx) => (
          <li key={event.id}>
            <div class="relative pb-8">
              {eventIdx !== timeline.length - 1 ? (
                <span
                  aria-hidden="true"
                  class="absolute top-4 left-4 -ml-px h-full w-0.5 bg-surface-2 dark:bg-white/10"
                />
              ) : null}
              <div class="relative flex space-x-3">
                <div>
                  <span
                    class={classNames(
                      event.iconBackground,
                      'flex size-8 items-center justify-center rounded-full ring-8 ring-surface-0 dark:ring-surface-1'
                    )}
                  >
                    <event.icon aria-hidden="true" class="size-5 text-white" />
                  </span>
                </div>
                <div class="flex min-w-0 flex-1 justify-between space-x-4 pt-1.5">
                  <div>
                    <p class="text-sm text-text-secondary">
                      {event.content}{' '}
                      <a href={event.href} class="font-medium text-text-primary">
                        {event.target}
                      </a>
                    </p>
                  </div>
                  <div class="whitespace-nowrap text-right text-sm text-text-secondary">
                    <time dateTime={event.datetime}>{event.date}</time>
                  </div>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

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

export function WithComments() {
  return (
    <ul role="list" class="space-y-6">
      {activity.map((activityItem, activityItemIdx) => (
        <li key={activityItem.id} class="relative flex gap-x-4">
          <div
            class={classNames(
              activityItemIdx === activity.length - 1 ? 'h-6' : '-bottom-6',
              'absolute top-0 left-0 flex w-6 justify-center'
            )}
          >
            <div class="w-px bg-surface-2 dark:bg-white/15" />
          </div>
          {activityItem.type === 'commented' ? (
            <>
              <img
                alt=""
                src={activityItem.person.imageUrl}
                class="relative mt-3 size-6 flex-none rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
              />
              <div class="flex-auto rounded-md p-3 ring-1 ring-surface-2 ring-inset dark:ring-white/15">
                <div class="flex justify-between gap-x-4">
                  <div class="py-0.5 text-xs/5 text-text-secondary">
                    <span class="font-medium text-text-primary">{activityItem.person.name}</span>{' '}
                    commented
                  </div>
                  <time
                    dateTime={activityItem.dateTime}
                    class="flex-none py-0.5 text-xs/5 text-text-secondary"
                  >
                    {activityItem.date}
                  </time>
                </div>
                <p class="text-sm/6 text-text-secondary">{activityItem.comment}</p>
              </div>
            </>
          ) : (
            <>
              <div class="relative flex size-6 flex-none items-center justify-center bg-surface-0 dark:bg-surface-1">
                {activityItem.type === 'paid' ? (
                  <CheckCircle
                    aria-hidden="true"
                    class="size-6 text-accent-500 dark:text-accent-400"
                  />
                ) : (
                  <Circle
                    aria-hidden="true"
                    class="size-1.5 rounded-full bg-surface-3 ring ring-surface-3 dark:bg-white/10 dark:ring-white/20"
                  />
                )}
              </div>
              <p class="flex-auto py-0.5 text-xs/5 text-text-secondary">
                <span class="font-medium text-text-primary">{activityItem.person.name}</span>{' '}
                {activityItem.type} the invoice.
              </p>
              <time
                dateTime={activityItem.dateTime}
                class="flex-none py-0.5 text-xs/5 text-text-secondary"
              >
                {activityItem.date}
              </time>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

const moods = [
  { name: 'Excited', value: 'excited', bgColor: 'bg-red-500' },
  { name: 'Loved', value: 'loved', bgColor: 'bg-pink-400' },
  { name: 'Happy', value: 'happy', bgColor: 'bg-green-400' },
  { name: 'Sad', value: 'sad', bgColor: 'bg-yellow-400' },
  { name: 'Thumbsy', value: 'thumbsy', bgColor: 'bg-blue-500' },
  { name: 'I feel nothing', value: null, bgColor: 'bg-transparent' },
];

export function WithCommentsAndMood() {
  const [selected, setSelected] = useState(moods[5]);

  return (
    <>
      <ul role="list" class="space-y-6">
        {activity.map((activityItem, activityItemIdx) => (
          <li key={activityItem.id} class="relative flex gap-x-4">
            <div
              class={classNames(
                activityItemIdx === activity.length - 1 ? 'h-6' : '-bottom-6',
                'absolute top-0 left-0 flex w-6 justify-center'
              )}
            >
              <div class="w-px bg-surface-2 dark:bg-white/15" />
            </div>
            {activityItem.type === 'commented' ? (
              <>
                <img
                  alt=""
                  src={activityItem.person.imageUrl}
                  class="relative mt-3 size-6 flex-none rounded-full bg-surface-1 outline -outline-offset-1 outline-black/5 dark:bg-surface-2 dark:outline-white/10"
                />
                <div class="flex-auto rounded-md p-3 ring-1 ring-surface-2 ring-inset dark:ring-white/15">
                  <div class="flex justify-between gap-x-4">
                    <div class="py-0.5 text-xs/5 text-text-secondary">
                      <span class="font-medium text-text-primary">{activityItem.person.name}</span>{' '}
                      commented
                    </div>
                    <time
                      dateTime={activityItem.dateTime}
                      class="flex-none py-0.5 text-xs/5 text-text-secondary"
                    >
                      {activityItem.date}
                    </time>
                  </div>
                  <p class="text-sm/6 text-text-secondary">{activityItem.comment}</p>
                </div>
              </>
            ) : (
              <>
                <div class="relative flex size-6 flex-none items-center justify-center bg-surface-0 dark:bg-surface-1">
                  {activityItem.type === 'paid' ? (
                    <CheckCircle
                      aria-hidden="true"
                      class="size-6 text-accent-500 dark:text-accent-400"
                    />
                  ) : (
                    <Circle
                      aria-hidden="true"
                      class="size-1.5 rounded-full bg-surface-3 ring ring-surface-3 dark:bg-white/10 dark:ring-white/20"
                    />
                  )}
                </div>
                <p class="flex-auto py-0.5 text-xs/5 text-text-secondary">
                  <span class="font-medium text-text-primary">{activityItem.person.name}</span>{' '}
                  {activityItem.type} the invoice.
                </p>
                <time
                  dateTime={activityItem.dateTime}
                  class="flex-none py-0.5 text-xs/5 text-text-secondary"
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
          class="size-6 flex-none rounded-full bg-surface-1 dark:bg-surface-2 dark:outline dark:-outline-offset-1 dark:outline-white/10"
        />
        <form action="#" class="relative flex-auto">
          <div class="overflow-hidden rounded-lg pb-12 outline-1 -outline-offset-1 outline-surface-2 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent-500 dark:bg-white/5 dark:outline-white/10">
            <textarea
              id="comment"
              name="comment"
              rows={2}
              placeholder="Add your comment..."
              class="block w-full resize-none bg-transparent px-3 py-1.5 text-base text-text-primary placeholder:text-text-muted focus:outline-none sm:text-sm/6"
              defaultValue={''}
            />
          </div>

          <div class="absolute inset-x-0 bottom-0 flex justify-between py-2 pr-2 pl-3">
            <div class="flex items-center space-x-5">
              <div class="flex items-center">
                <button
                  type="button"
                  class="-m-2.5 flex size-10 items-center justify-center rounded-full text-text-secondary hover:text-text-primary dark:text-text-secondary dark:hover:text-text-primary"
                >
                  <Paperclip aria-hidden="true" class="size-5" />
                  <span class="sr-only">Attach a file</span>
                </button>
              </div>
              <Listbox value={selected} onChange={setSelected}>
                <div class="relative">
                  <ListboxButton class="relative -m-2.5 flex size-10 items-center justify-center rounded-full text-text-secondary hover:text-text-primary dark:text-text-secondary dark:hover:text-text-primary cursor-pointer outline-none">
                    {selected.value === null ? (
                      <Smile aria-hidden="true" class="size-5 shrink-0" />
                    ) : (
                      <div
                        class={classNames(
                          selected.bgColor,
                          'flex size-8 items-center justify-center rounded-full'
                        )}
                      >
                        <Smile aria-hidden="true" class="size-5 shrink-0 text-white" />
                      </div>
                    )}
                    <span class="sr-only">Add your mood</span>
                  </ListboxButton>
                  <ListboxOptions class="absolute bottom-10 z-10 -ml-6 w-60 rounded-lg bg-surface-1 py-3 text-base shadow-xl border border-surface-border data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:ml-auto sm:w-64 sm:text-sm outline-none">
                    {moods.map((mood) => (
                      <ListboxOption
                        key={mood.value}
                        value={mood}
                        class="relative cursor-pointer bg-transparent px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[selected]:bg-accent-500 data-[selected]:text-white"
                      >
                        <div class="flex items-center">
                          <div
                            class={classNames(
                              mood.bgColor,
                              'flex size-8 items-center justify-center rounded-full'
                            )}
                          >
                            <Smile
                              aria-hidden="true"
                              class={classNames(
                                mood.value === null ? 'text-text-secondary' : 'text-white',
                                'size-5 shrink-0'
                              )}
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
            <button
              type="submit"
              class="rounded-md bg-accent-500 px-2.5 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-accent-600 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400"
            >
              Comment
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

export function FeedsDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple with icons</h3>
        <SimpleWithIcons />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With comments</h3>
        <WithComments />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With comments and mood selector</h3>
        <WithCommentsAndMood />
      </div>
    </div>
  );
}
