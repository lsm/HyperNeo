import { useState } from 'preact/hooks';
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '../../src/mod.ts';

interface Framework {
  id: number;
  name: string;
  language: string;
}

const frameworks: Framework[] = [
  { id: 1, name: 'React', language: 'JavaScript' },
  { id: 2, name: 'Preact', language: 'JavaScript' },
  { id: 3, name: 'Vue', language: 'JavaScript' },
  { id: 4, name: 'Svelte', language: 'JavaScript' },
  { id: 5, name: 'Angular', language: 'TypeScript' },
  { id: 6, name: 'SolidJS', language: 'JavaScript' },
  { id: 7, name: 'Qwik', language: 'TypeScript' },
  { id: 8, name: 'Remix', language: 'TypeScript' },
];

const countries = [
  'Australia',
  'Austria',
  'Belgium',
  'Brazil',
  'Canada',
  'Chile',
  'China',
  'Czech Republic',
  'Denmark',
  'Finland',
  'France',
  'Germany',
  'Greece',
  'Hungary',
  'India',
  'Indonesia',
  'Ireland',
  'Israel',
  'Italy',
  'Japan',
  'Mexico',
  'Netherlands',
  'New Zealand',
  'Norway',
  'Poland',
  'Portugal',
  'South Korea',
  'Spain',
  'Sweden',
  'Switzerland',
  'United Kingdom',
  'United States',
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

export function ComboboxDemo() {
  const [selectedFramework, setSelectedFramework] = useState<Framework | null>(null);
  const [frameworkQuery, setFrameworkQuery] = useState('');

  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [countryQuery, setCountryQuery] = useState('');

  const filteredFrameworks =
    frameworkQuery === ''
      ? frameworks
      : frameworks.filter(
          (f) =>
            f.name.toLowerCase().includes(frameworkQuery.toLowerCase()) ||
            f.language.toLowerCase().includes(frameworkQuery.toLowerCase())
        );

  const filteredCountries =
    countryQuery === ''
      ? countries
      : countries.filter((c) => c.toLowerCase().includes(countryQuery.toLowerCase()));

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Framework selector with filtering
        </h3>
        <Combobox value={selectedFramework} onChange={setSelectedFramework} by="id">
          <div class="relative w-72">
            <div class="flex items-center rounded-lg bg-surface-2 border border-surface-border hover:border-accent-500 focus-within:border-accent-500 transition-colors">
              <ComboboxInput
                class="flex-1 bg-transparent px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none"
                displayValue={(fw: Framework) => fw?.name ?? ''}
                onChange={(e) => setFrameworkQuery((e.target as HTMLInputElement).value)}
                placeholder="Search frameworks…"
              />
              <ComboboxButton class="flex items-center justify-center px-2 text-text-tertiary hover:text-text-primary transition-colors cursor-pointer">
                <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fill-rule="evenodd"
                    d="M10 3a1 1 0 01.707.293l3 3a1 1 0 01-1.414 1.414L10 5.414 7.707 7.707a1 1 0 01-1.414-1.414l3-3A1 1 0 0110 3zm-3.707 9.293a1 1 0 011.414 0L10 14.586l2.293-2.293a1 1 0 011.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                    clip-rule="evenodd"
                  />
                </svg>
              </ComboboxButton>
            </div>
            <ComboboxOptions class="absolute left-0 top-full mt-1 w-full bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none max-h-60 overflow-y-auto">
              {filteredFrameworks.length === 0 ? (
                <div class="px-3 py-2 text-sm text-text-muted">No results found</div>
              ) : (
                filteredFrameworks.map((fw) => (
                  <ComboboxOption
                    key={fw.id}
                    value={fw}
                    class="group flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
                  >
                    <span class="w-4 flex-shrink-0 text-accent-400 group-data-[focus]:text-white invisible group-data-[selected]:visible">
                      <CheckIcon />
                    </span>
                    <div class="flex-1 min-w-0">
                      <p class="text-text-primary group-data-[focus]:text-white">{fw.name}</p>
                      <p class="text-xs text-text-muted group-data-[focus]:text-accent-200">
                        {fw.language}
                      </p>
                    </div>
                  </ComboboxOption>
                ))
              )}
            </ComboboxOptions>
          </div>
        </Combobox>
        {selectedFramework && (
          <p class="mt-2 text-sm text-text-tertiary">
            Selected: <span class="text-text-primary">{selectedFramework.name}</span>{' '}
            <span class="text-accent-400">({selectedFramework.language})</span>
          </p>
        )}
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Country search with "No results" state
        </h3>
        <Combobox value={selectedCountry} onChange={setSelectedCountry}>
          <div class="relative w-72">
            <div class="flex items-center rounded-lg bg-surface-2 border border-surface-border hover:border-accent-500 focus-within:border-accent-500 transition-colors">
              <ComboboxInput
                class="flex-1 bg-transparent px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none"
                displayValue={(c: string) => c ?? ''}
                onChange={(e) => setCountryQuery((e.target as HTMLInputElement).value)}
                placeholder="Search countries…"
              />
              <ComboboxButton class="flex items-center justify-center px-2 text-text-tertiary hover:text-text-primary transition-colors cursor-pointer">
                <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fill-rule="evenodd"
                    d="M10 3a1 1 0 01.707.293l3 3a1 1 0 01-1.414 1.414L10 5.414 7.707 7.707a1 1 0 01-1.414-1.414l3-3A1 1 0 0110 3zm-3.707 9.293a1 1 0 011.414 0L10 14.586l2.293-2.293a1 1 0 011.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                    clip-rule="evenodd"
                  />
                </svg>
              </ComboboxButton>
            </div>
            <ComboboxOptions class="absolute left-0 top-full mt-1 w-full bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none max-h-52 overflow-y-auto">
              {filteredCountries.length === 0 ? (
                <div class="px-3 py-3 text-sm text-text-muted text-center">
                  <p>No countries match</p>
                  <p class="text-xs mt-0.5 text-text-muted">Try a different search term</p>
                </div>
              ) : (
                filteredCountries.map((country) => (
                  <ComboboxOption
                    key={country}
                    value={country}
                    class="group flex items-center gap-2 px-3 py-2 rounded text-sm text-text-primary cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
                  >
                    <span class="flex-1 group-data-[focus]:text-white">{country}</span>
                    <span class="text-accent-400 group-data-[focus]:text-white invisible group-data-[selected]:visible">
                      <CheckIcon />
                    </span>
                  </ComboboxOption>
                ))
              )}
            </ComboboxOptions>
          </div>
        </Combobox>
        {selectedCountry && (
          <p class="mt-2 text-sm text-text-tertiary">
            Selected: <span class="text-text-primary">{selectedCountry}</span>
          </p>
        )}
      </div>
    </div>
  );
}
