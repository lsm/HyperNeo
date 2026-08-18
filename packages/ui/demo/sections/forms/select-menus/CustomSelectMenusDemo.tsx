import { useState } from 'preact/hooks';
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Label,
} from '../../../../src/mod.ts';
import { classNames } from '../../../../src/internal/class-names.ts';
import { ChevronDown, Check } from 'lucide-preact';

const people = [
  { id: 1, name: 'Wade Cooper', username: '@wadecooper' },
  { id: 2, name: 'Arlene Mccoy', username: '@arlenemccoy' },
  { id: 3, name: 'Devon Webb', username: '@devonwebb' },
  { id: 4, name: 'Tom Cook', username: '@tomcook' },
  { id: 5, name: 'Tanya Fox', username: '@tanyafox' },
  { id: 6, name: 'Hellen Schmidt', username: '@hellenschmidt' },
  { id: 7, name: 'Caroline Schultz', username: '@carolineschultz' },
  { id: 8, name: 'Mason Heaney', username: '@masonheaney' },
  { id: 9, name: 'Claudie Smitham', username: '@claudiesmitham' },
  { id: 10, name: 'Emil Schaefer', username: '@emilschaefer' },
];

const peopleWithStatus = [
  { id: 1, name: 'Wade Cooper', online: true },
  { id: 2, name: 'Arlene Mccoy', online: false },
  { id: 3, name: 'Devon Webb', online: false },
  { id: 4, name: 'Tom Cook', online: true },
  { id: 5, name: 'Tanya Fox', online: false },
  { id: 6, name: 'Hellen Schmidt', online: true },
  { id: 7, name: 'Caroline Schultz', online: true },
  { id: 8, name: 'Mason Heaney', online: false },
  { id: 9, name: 'Claudie Smitham', online: true },
  { id: 10, name: 'Emil Schaefer', online: false },
];

const peopleWithAvatar = [
  {
    id: 1,
    name: 'Wade Cooper',
    avatar:
      'https://images.unsplash.com/photo-1491528323818-fdd1faba62cc?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 2,
    name: 'Arlene Mccoy',
    avatar:
      'https://images.unsplash.com/photo-1550525811-e5869dd03032?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 3,
    name: 'Devon Webb',
    avatar:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2.25&w=256&h=256&q=80',
  },
  {
    id: 4,
    name: 'Tom Cook',
    avatar:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 5,
    name: 'Tanya Fox',
    avatar:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 6,
    name: 'Hellen Schmidt',
    avatar:
      'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 7,
    name: 'Caroline Schultz',
    avatar:
      'https://images.unsplash.com/photo-1568409938619-12e139227838?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 8,
    name: 'Mason Heaney',
    avatar:
      'https://images.unsplash.com/photo-1531427186611-ecfd6d936c79?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 9,
    name: 'Claudie Smitham',
    avatar:
      'https://images.unsplash.com/photo-1584486520270-19eca1efcce5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 10,
    name: 'Emil Schaefer',
    avatar:
      'https://images.unsplash.com/photo-1561505457-3bcad021f8ee?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

const publishingOptions = [
  {
    value: 'published',
    title: 'Published',
    description: 'This job posting can be viewed by anyone who has the link.',
    current: true,
  },
  {
    value: 'draft',
    title: 'Draft',
    description: 'This job posting will no longer be publicly accessible.',
    current: false,
  },
];

export function CustomSelectMenusDemo() {
  const [selected, setSelected] = useState(people[3]);
  const [selectedWithStatus, setSelectedWithStatus] = useState(peopleWithStatus[3]);
  const [selectedWithAvatar, setSelectedWithAvatar] = useState(peopleWithAvatar[3]);
  const [selectedWithCheckLeft, setSelectedWithCheckLeft] = useState(people[3]);
  const [selectedPublish, setSelectedPublish] = useState(publishingOptions[0]);

  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Simple custom select</h3>
        <Listbox value={selected} onChange={setSelected}>
          <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
          <div class="relative mt-2">
            <ListboxButton class="grid w-full cursor-default grid-cols-1 rounded-md bg-surface-1 py-1.5 pr-2 pl-3 text-left text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:focus:outline-accent-500">
              <span class="col-start-1 row-start-1 flex w-full gap-2 pr-6">
                <span class="truncate">{selected.name}</span>
                <span class="truncate text-text-secondary">{selected.username}</span>
              </span>
              <ChevronDown
                aria-hidden="true"
                class="col-start-1 row-start-1 size-5 self-center justify-self-end text-text-secondary sm:size-4"
              />
            </ListboxButton>

            <ListboxOptions
              transition
              class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:text-sm dark:bg-gray-800 dark:shadow-none dark:outline-white/10"
            >
              {people.map((person) => (
                <ListboxOption
                  key={person.username}
                  value={person}
                  class="group relative cursor-default py-2 pr-9 pl-3 text-text-primary select-none data-[focus]:bg-accent-600 data-[focus]:text-white data-[focus]:outline-hidden dark:text-white dark:data-[focus]:bg-accent-500"
                >
                  <div class="flex">
                    <span class="truncate font-normal group-data-selected:font-semibold">
                      {person.name}
                    </span>
                    <span class="ml-2 truncate text-text-secondary group-data-focus:text-white dark:text-gray-400 dark:group-data-focus:text-white">
                      {person.username}
                    </span>
                  </div>

                  <span class="absolute inset-y-0 right-0 flex items-center pr-4 text-accent-600 group-not-data-selected:hidden group-data-focus:text-white dark:text-accent-400">
                    <Check aria-hidden="true" class="size-5" />
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Custom select with check on left
        </h3>
        <Listbox value={selectedWithCheckLeft} onChange={setSelectedWithCheckLeft}>
          <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
          <div class="relative mt-2">
            <ListboxButton class="grid w-full cursor-default grid-cols-1 rounded-md bg-surface-1 py-1.5 pr-2 pl-3 text-left text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:focus:outline-accent-500">
              <span class="col-start-1 row-start-1 truncate pr-6">
                {selectedWithCheckLeft.name}
              </span>
              <ChevronDown
                aria-hidden="true"
                class="col-start-1 row-start-1 size-5 self-center justify-self-end text-text-secondary sm:size-4"
              />
            </ListboxButton>

            <ListboxOptions
              transition
              class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:text-sm dark:bg-gray-800 dark:shadow-none dark:outline-white/10"
            >
              {people.map((person) => (
                <ListboxOption
                  key={person.id}
                  value={person}
                  class="group relative cursor-default py-2 pr-4 pl-8 text-text-primary select-none data-[focus]:bg-accent-600 data-[focus]:text-white data-[focus]:outline-hidden dark:text-white dark:data-[focus]:bg-accent-500"
                >
                  <span class="block truncate font-normal group-data-selected:font-semibold">
                    {person.name}
                  </span>

                  <span class="absolute inset-y-0 left-0 flex items-center pl-1.5 text-accent-600 group-not-data-selected:hidden group-data-focus:text-white dark:text-accent-400">
                    <Check aria-hidden="true" class="size-5" />
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Custom select with status indicator
        </h3>
        <Listbox value={selectedWithStatus} onChange={setSelectedWithStatus}>
          <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
          <div class="relative mt-2">
            <ListboxButton class="grid w-full cursor-default grid-cols-1 rounded-md bg-surface-1 py-1.5 pr-2 pl-3 text-left text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:focus:outline-accent-500">
              <span class="col-start-1 row-start-1 flex items-center gap-3 pr-6">
                <span
                  aria-label={selectedWithStatus.online ? 'Online' : 'Offline'}
                  class={classNames(
                    selectedWithStatus.online ? 'bg-green-400' : 'bg-gray-200 dark:bg-gray-600',
                    'inline-block size-2 shrink-0 rounded-full border border-transparent'
                  )}
                />
                <span class="block truncate">{selectedWithStatus.name}</span>
              </span>
              <ChevronDown
                aria-hidden="true"
                class="col-start-1 row-start-1 size-5 self-center justify-self-end text-text-secondary sm:size-4"
              />
            </ListboxButton>

            <ListboxOptions
              transition
              class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:text-sm dark:bg-gray-800 dark:shadow-none dark:outline-white/10"
            >
              {peopleWithStatus.map((person) => (
                <ListboxOption
                  key={person.id}
                  value={person}
                  class="group relative cursor-default py-2 pr-9 pl-3 text-text-primary select-none data-[focus]:bg-accent-600 data-[focus]:text-white data-[focus]:outline-hidden dark:text-white dark:data-[focus]:bg-accent-500"
                >
                  <div class="flex items-center">
                    <span
                      aria-hidden="true"
                      class={classNames(
                        person.online ? 'bg-green-400' : 'bg-gray-200 dark:bg-white/25',
                        'inline-block size-2 shrink-0 rounded-full border border-transparent'
                      )}
                    />
                    <span class="ml-3 block truncate font-normal group-data-selected:font-semibold">
                      {person.name}
                      <span class="sr-only"> is {person.online ? 'online' : 'offline'}</span>
                    </span>
                  </div>

                  <span class="absolute inset-y-0 right-0 flex items-center pr-4 text-accent-600 group-not-data-selected:hidden group-data-focus:text-white dark:text-accent-400">
                    <Check aria-hidden="true" class="size-5" />
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Custom select with avatar</h3>
        <Listbox value={selectedWithAvatar} onChange={setSelectedWithAvatar}>
          <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
          <div class="relative mt-2">
            <ListboxButton class="grid w-full cursor-default grid-cols-1 rounded-md bg-surface-1 py-1.5 pr-2 pl-3 text-left text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-gray-800/50 dark:text-white dark:outline-white/10 dark:focus:outline-accent-500">
              <span class="col-start-1 row-start-1 flex items-center gap-3 pr-6">
                <img
                  alt=""
                  src={selectedWithAvatar.avatar}
                  class="size-5 shrink-0 rounded-full bg-surface-2 dark:outline dark:outline-white/10"
                />
                <span class="block truncate">{selectedWithAvatar.name}</span>
              </span>
              <ChevronDown
                aria-hidden="true"
                class="col-start-1 row-start-1 size-5 self-center justify-self-end text-text-secondary sm:size-4"
              />
            </ListboxButton>

            <ListboxOptions
              transition
              class="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:text-sm dark:bg-gray-800 dark:shadow-none dark:outline-white/10"
            >
              {peopleWithAvatar.map((person) => (
                <ListboxOption
                  key={person.id}
                  value={person}
                  class="group relative cursor-default py-2 pr-9 pl-3 text-text-primary select-none data-[focus]:bg-accent-600 data-[focus]:text-white data-[focus]:outline-hidden dark:text-white dark:data-[focus]:bg-accent-500"
                >
                  <div class="flex items-center">
                    <img
                      alt=""
                      src={person.avatar}
                      class="size-5 shrink-0 rounded-full dark:outline dark:outline-white/10"
                    />
                    <span class="ml-3 block truncate font-normal group-data-selected:font-semibold">
                      {person.name}
                    </span>
                  </div>

                  <span class="absolute inset-y-0 right-0 flex items-center pr-4 text-accent-600 group-not-data-selected:hidden group-data-focus:text-white dark:text-accent-400">
                    <Check aria-hidden="true" class="size-5" />
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Select with secondary text</h3>
        <Listbox value={selected} onChange={setSelected}>
          <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
          <div class="relative mt-2">
            <ListboxButton class="grid w-full cursor-default grid-cols-1 rounded-md bg-surface-1 py-1.5 pr-2 pl-3 text-left text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:focus:outline-accent-500">
              <span class="col-start-1 row-start-1 truncate pr-6">{selected.name}</span>
              <ChevronDown
                aria-hidden="true"
                class="col-start-1 row-start-1 size-5 self-center justify-self-end text-text-secondary sm:size-4"
              />
            </ListboxButton>

            <ListboxOptions
              transition
              class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 sm:text-sm dark:bg-gray-800 dark:shadow-none dark:outline-white/10"
            >
              {people.map((person) => (
                <ListboxOption
                  key={person.id}
                  value={person}
                  class="group relative cursor-default py-2 pr-9 pl-3 text-text-primary select-none data-[focus]:bg-accent-600 data-[focus]:text-white data-[focus]:outline-hidden dark:text-white dark:data-[focus]:bg-accent-500"
                >
                  <span class="block truncate font-normal group-data-selected:font-semibold">
                    {person.name}
                  </span>

                  <span class="absolute inset-y-0 right-0 flex items-center pr-4 text-accent-600 group-not-data-selected:hidden group-data-focus:text-white dark:text-accent-400">
                    <Check aria-hidden="true" class="size-5" />
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Branded select with supporting text
        </h3>
        <Listbox value={selectedPublish} onChange={setSelectedPublish}>
          <Label class="sr-only">Change published status</Label>
          <div class="relative">
            <div class="inline-flex divide-x divide-accent-700 rounded-md outline-hidden dark:divide-accent-600">
              <div class="inline-flex items-center gap-x-1.5 rounded-l-md bg-accent-600 px-3 py-2 text-white dark:bg-accent-500">
                <Check aria-hidden="true" class="-ml-0.5 size-5" />
                <p class="text-sm font-semibold">{selectedPublish.title}</p>
              </div>
              <ListboxButton class="inline-flex items-center rounded-l-none rounded-r-md bg-accent-600 p-2 hover:bg-accent-700 focus-visible:outline-2 focus-visible:outline-accent-400 dark:bg-accent-500 dark:hover:bg-accent-400 dark:focus-visible:outline-accent-400">
                <span class="sr-only">Change published status</span>
                <ChevronDown aria-hidden="true" class="size-5 text-white" />
              </ListboxButton>
            </div>

            <ListboxOptions
              transition
              class="absolute right-0 z-10 mt-2 w-72 origin-top-right divide-y divide-surface-border overflow-hidden rounded-md bg-surface-1 shadow-lg outline-1 outline-black/5 data-leave:transition data-leave:duration-100 data-leave:ease-in data-closed:data-leave:opacity-0 dark:divide-white/10 dark:bg-gray-800 dark:shadow-none dark:outline-white/10"
            >
              {publishingOptions.map((option) => (
                <ListboxOption
                  key={option.title}
                  value={option}
                  class="group cursor-default p-4 text-sm text-text-primary select-none data-[focus]:bg-accent-600 data-[focus]:text-white dark:text-white dark:data-[focus]:bg-accent-500"
                >
                  <div class="flex flex-col">
                    <div class="flex justify-between">
                      <p class="font-normal group-data-selected:font-semibold">{option.title}</p>
                      <span class="text-accent-600 group-not-data-selected:hidden group-data-focus:text-white dark:text-accent-400">
                        <Check aria-hidden="true" class="size-5" />
                      </span>
                    </div>
                    <p class="mt-2 text-text-secondary group-data-focus:text-white">
                      {option.description}
                    </p>
                  </div>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>
    </div>
  );
}
