import { useState } from 'preact/hooks';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '../../src/mod.ts';

interface Person {
  id: number;
  name: string;
  role: string;
  disabled?: boolean;
}

const people: Person[] = [
  { id: 1, name: 'Alice Johnson', role: 'Engineer' },
  { id: 2, name: 'Bob Smith', role: 'Designer' },
  { id: 3, name: 'Carol Williams', role: 'Product Manager' },
  { id: 4, name: 'David Lee', role: 'Engineer' },
  { id: 5, name: 'Eve Davis', role: 'DevOps', disabled: true },
  { id: 6, name: 'Frank Miller', role: 'Engineer' },
];

const colors = [
  { id: 'red', label: 'Red', swatch: 'bg-red-500' },
  { id: 'green', label: 'Green', swatch: 'bg-green-500' },
  { id: 'blue', label: 'Blue', swatch: 'bg-blue-500' },
  { id: 'purple', label: 'Purple', swatch: 'bg-purple-500' },
  { id: 'yellow', label: 'Yellow', swatch: 'bg-yellow-500' },
];

function CheckIcon() {
  return (
    <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg class="w-4 h-4 text-text-tertiary" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M10 3a1 1 0 01.707.293l3 3a1 1 0 01-1.414 1.414L10 5.414 7.707 7.707a1 1 0 01-1.414-1.414l3-3A1 1 0 0110 3zm-3.707 9.293a1 1 0 011.414 0L10 14.586l2.293-2.293a1 1 0 011.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

export function ListboxDemo() {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [selectedColor, setSelectedColor] = useState<(typeof colors)[0] | null>(null);

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          People selector with disabled option
        </h3>
        <Listbox value={selectedPerson} onChange={setSelectedPerson} by="id">
          <div class="relative w-64">
            <ListboxButton class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer outline-none data-[focus]:border-accent-500">
              {selectedPerson ? (
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-6 h-6 rounded-full bg-accent-500/20 flex items-center justify-center text-accent-400 text-xs font-medium flex-shrink-0">
                    {selectedPerson.name[0]}
                  </div>
                  <span class="truncate">{selectedPerson.name}</span>
                </div>
              ) : (
                <span class="text-text-muted">Select a person…</span>
              )}
              <ChevronIcon />
            </ListboxButton>
            <ListboxOptions class="absolute left-0 top-full mt-1 w-full bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none max-h-60 overflow-y-auto">
              {people.map((person) => (
                <ListboxOption
                  key={person.id}
                  value={person}
                  disabled={person.disabled}
                  class="group flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed transition-colors"
                >
                  <div class="w-5 flex-shrink-0 text-accent-400 group-data-[focus]:text-white group-data-[selected]:visible invisible">
                    <CheckIcon />
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-text-primary group-data-[focus]:text-white truncate">
                      {person.name}
                    </p>
                    <p class="text-xs text-text-muted group-data-[focus]:text-accent-200 truncate">
                      {person.role}
                      {person.disabled ? ' — unavailable' : ''}
                    </p>
                  </div>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
        {selectedPerson && (
          <p class="mt-2 text-sm text-text-tertiary">
            Selected: <span class="text-text-primary">{selectedPerson.name}</span>{' '}
            <span class="text-accent-400">({selectedPerson.role})</span>
          </p>
        )}
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">Color selector with swatch</h3>
        <Listbox value={selectedColor} onChange={setSelectedColor} by="id">
          <div class="relative w-48">
            <ListboxButton class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer outline-none data-[focus]:border-accent-500">
              {selectedColor ? (
                <div class="flex items-center gap-2">
                  <span class={`w-3 h-3 rounded-full ${selectedColor.swatch} flex-shrink-0`} />
                  <span>{selectedColor.label}</span>
                </div>
              ) : (
                <span class="text-text-muted">Pick a color…</span>
              )}
              <ChevronIcon />
            </ListboxButton>
            <ListboxOptions class="absolute left-0 top-full mt-1 w-full bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
              {colors.map((color) => (
                <ListboxOption
                  key={color.id}
                  value={color}
                  class="group flex items-center gap-2.5 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
                >
                  <span class={`w-3 h-3 rounded-full ${color.swatch} flex-shrink-0`} />
                  <span class="flex-1 text-text-primary group-data-[focus]:text-white">
                    {color.label}
                  </span>
                  <span class="text-accent-400 group-data-[focus]:text-white invisible group-data-[selected]:visible">
                    <CheckIcon />
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </div>
    </div>
  );
}
