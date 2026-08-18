import { useState } from 'preact/hooks';
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Label,
} from '../../../../src/mod.ts';
import { classNames } from '../../../../src/internal/class-names.ts';
import { ChevronDown, User } from 'lucide-preact';

const people = [
  { name: 'Leslie Alexander', username: '@lesliealexander' },
  { name: 'Michael Foster', username: '@michaelfoster' },
  { name: 'Dries Vincent', username: '@driesvincent' },
  { name: 'Jenna Collins', username: '@jennacollins' },
];

const peopleWithStatus = [
  { id: 1, name: 'Leslie Alexander', online: true },
  { id: 2, name: 'Michael Foster', online: false },
  { id: 3, name: 'Dries Vincent', online: true },
  { id: 4, name: 'Jenna Collins', online: false },
];

const peopleWithAvatar = [
  {
    id: 1,
    name: 'Leslie Alexander',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 2,
    name: 'Michael Foster',
    imageUrl:
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 3,
    name: 'Dries Vincent',
    imageUrl:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 4,
    name: 'Jenna Collins',
    imageUrl:
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

export function ComboboxesDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Simple combobox</h3>
        <SimpleCombobox />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With status indicator</h3>
        <StatusIndicatorCombobox />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With avatar</h3>
        <AvatarCombobox />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With secondary text</h3>
        <SecondaryTextCombobox />
      </div>
    </div>
  );
}

function SimpleCombobox() {
  const [query, setQuery] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<(typeof people)[0] | null>(null);

  const filteredPeople =
    query === ''
      ? people
      : people.filter((person) => {
          return person.name.toLowerCase().includes(query.toLowerCase());
        });

  return (
    <Combobox
      as="div"
      value={selectedPerson}
      onChange={(person) => {
        setQuery('');
        setSelectedPerson(person);
      }}
    >
      <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
      <div class="relative mt-2">
        <ComboboxInput
          class="block w-full rounded-md bg-surface-1 py-1.5 pr-12 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border placeholder:text-text-muted focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6"
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          onBlur={() => setQuery('')}
          displayValue={(person: (typeof people)[0] | null) => person?.name ?? ''}
        />
        <ComboboxButton class="absolute inset-y-0 right-0 flex items-center rounded-r-md px-2 focus:outline-hidden">
          <ChevronDown class="size-5 text-text-tertiary" aria-hidden="true" />
        </ComboboxButton>

        <ComboboxOptions
          transition
          class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline outline-black/5 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in data-[closed]:data-[leave]:opacity-0 sm:text-sm"
        >
          {query.length > 0 && (
            <ComboboxOption
              value={{ id: null, name: query }}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              {query}
            </ComboboxOption>
          )}
          {filteredPeople.map((person) => (
            <ComboboxOption
              key={person.username}
              value={person}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex">
                <span class="block truncate">{person.name}</span>
                <span class="ml-2 block truncate text-text-muted data-[focus]:text-white">
                  {person.username}
                </span>
              </div>
            </ComboboxOption>
          ))}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}

function StatusIndicatorCombobox() {
  const [query, setQuery] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<{
    id: number;
    name: string;
    online: boolean;
  } | null>(null);

  const filteredPeople =
    query === ''
      ? peopleWithStatus
      : peopleWithStatus.filter((person) => {
          return person.name.toLowerCase().includes(query.toLowerCase());
        });

  return (
    <Combobox
      as="div"
      value={selectedPerson}
      onChange={(person) => {
        setQuery('');
        setSelectedPerson(person);
      }}
    >
      <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
      <div class="relative mt-2">
        <ComboboxInput
          class="block w-full rounded-md bg-surface-1 py-1.5 pr-12 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border placeholder:text-text-muted focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6"
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          onBlur={() => setQuery('')}
          displayValue={(person: (typeof peopleWithStatus)[0] | null) => person?.name ?? ''}
        />
        <ComboboxButton class="absolute inset-y-0 right-0 flex items-center rounded-r-md px-2 focus:outline-hidden">
          <ChevronDown class="size-5 text-text-tertiary" aria-hidden="true" />
        </ComboboxButton>

        <ComboboxOptions
          transition
          class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline outline-black/5 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in data-[closed]:data-[leave]:opacity-0 sm:text-sm"
        >
          {query.length > 0 && (
            <ComboboxOption
              value={{ id: null, name: query, online: false }}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex items-center">
                <span
                  class="inline-block size-2 shrink-0 rounded-full border border-surface-border"
                  aria-hidden="true"
                />
                <span class="ml-3 block truncate">{query}</span>
              </div>
            </ComboboxOption>
          )}
          {filteredPeople.map((person) => (
            <ComboboxOption
              key={person.id}
              value={person}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex items-center">
                <span
                  class={classNames(
                    'inline-block size-2 shrink-0 rounded-full',
                    person.online ? 'bg-green-400' : 'bg-surface-3'
                  )}
                  aria-hidden="true"
                />
                <span class="ml-3 block truncate">
                  {person.name}
                  <span class="sr-only"> is {person.online ? 'online' : 'offline'}</span>
                </span>
              </div>
            </ComboboxOption>
          ))}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}

function AvatarCombobox() {
  const [query, setQuery] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<{
    id: number;
    name: string;
    imageUrl: string;
  } | null>(null);

  const filteredPeople =
    query === ''
      ? peopleWithAvatar
      : peopleWithAvatar.filter((person) => {
          return person.name.toLowerCase().includes(query.toLowerCase());
        });

  return (
    <Combobox
      as="div"
      value={selectedPerson}
      onChange={(person) => {
        setQuery('');
        setSelectedPerson(person);
      }}
    >
      <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
      <div class="relative mt-2">
        <ComboboxInput
          class="block w-full rounded-md bg-surface-1 py-1.5 pr-12 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border placeholder:text-text-muted focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6"
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          onBlur={() => setQuery('')}
          displayValue={(person: (typeof peopleWithAvatar)[0] | null) => person?.name ?? ''}
        />
        <ComboboxButton class="absolute inset-y-0 right-0 flex items-center rounded-r-md px-2 focus:outline-hidden">
          <ChevronDown class="size-5 text-text-tertiary" aria-hidden="true" />
        </ComboboxButton>

        <ComboboxOptions
          transition
          class="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline outline-black/5 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in data-[closed]:data-[leave]:opacity-0 sm:text-sm"
        >
          {query.length > 0 && (
            <ComboboxOption
              value={{ id: null, name: query, imageUrl: '' }}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex items-center">
                <div class="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3">
                  <User class="size-4 text-text-tertiary" aria-hidden="true" />
                </div>
                <span class="ml-3 block truncate">{query}</span>
              </div>
            </ComboboxOption>
          )}
          {filteredPeople.map((person) => (
            <ComboboxOption
              key={person.id}
              value={person}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex items-center">
                <img
                  src={person.imageUrl}
                  alt=""
                  class="size-6 shrink-0 rounded-full bg-surface-2 outline -outline-offset-1 outline-black/5"
                />
                <span class="ml-3 block truncate">{person.name}</span>
              </div>
            </ComboboxOption>
          ))}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}

function SecondaryTextCombobox() {
  const [query, setQuery] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<{ name: string; username: string } | null>(
    null
  );

  const filteredPeople =
    query === ''
      ? people
      : people.filter((person) => {
          return person.name.toLowerCase().includes(query.toLowerCase());
        });

  return (
    <Combobox
      as="div"
      value={selectedPerson}
      onChange={(person) => {
        setQuery('');
        setSelectedPerson(person);
      }}
    >
      <Label class="block text-sm/6 font-medium text-text-primary">Assigned to</Label>
      <div class="relative mt-2">
        <ComboboxInput
          class="block w-full rounded-md bg-surface-1 py-1.5 pr-12 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border placeholder:text-text-muted focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6"
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          onBlur={() => setQuery('')}
          displayValue={(person: (typeof people)[0] | null) => person?.name ?? ''}
        />
        <ComboboxButton class="absolute inset-y-0 right-0 flex items-center rounded-r-md px-2 focus:outline-hidden">
          <ChevronDown class="size-5 text-text-tertiary" aria-hidden="true" />
        </ComboboxButton>

        <ComboboxOptions
          transition
          class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-surface-1 py-1 text-base shadow-lg outline outline-black/5 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in data-[closed]:data-[leave]:opacity-0 sm:text-sm"
        >
          {query.length > 0 && (
            <ComboboxOption
              value={{ id: null, name: query }}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex items-center justify-between">
                <span class="block truncate">{query}</span>
                <span class="ml-2 block truncate text-text-muted">Create new</span>
              </div>
            </ComboboxOption>
          )}
          {filteredPeople.map((person) => (
            <ComboboxOption
              key={person.username}
              value={person}
              class="cursor-default px-3 py-2 text-text-primary select-none data-[focus]:bg-accent-500 data-[focus]:text-white data-[focus]:outline-hidden"
            >
              <div class="flex items-center justify-between">
                <span class="block truncate">{person.name}</span>
                <span class="ml-2 block truncate text-text-muted data-[focus]:text-white">
                  {person.username}
                </span>
              </div>
            </ComboboxOption>
          ))}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}
