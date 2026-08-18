import { Input, InputGroup, InputAddon, Select } from '../../src/mod.ts';
import { Mail, AlertCircle, HelpCircle, Users } from 'lucide-preact';

const inputClass =
  'block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500';

const inputErrorClass =
  'text-red-900 outline-red-300 placeholder:text-red-300 dark:text-red-400 dark:outline-red-500/50 dark:placeholder:text-red-400/70 dark:focus:outline-red-400';

const inputDisabledClass =
  'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 disabled:outline-gray-200 dark:disabled:bg-white/10 dark:disabled:text-gray-500 dark:disabled:outline-white/5';

export function InputGroupsDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with label</h3>
        <Input type="email" placeholder="Enter your email" class={inputClass} />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with label and help text</h3>
        <div>
          <Input
            type="email"
            placeholder="you@example.com"
            class={inputClass}
            aria-describedby="email-description"
          />
          <p id="email-description" class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            We'll use this email address to send you notifications.
          </p>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with validation error</h3>
        <Input
          type="email"
          placeholder="you@example.com"
          invalid
          class={`${inputClass} ${inputErrorClass}`}
        />
        <p class="mt-2 text-sm text-red-600 dark:text-red-400">
          Please enter a valid email address.
        </p>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with disabled state</h3>
        <Input
          type="email"
          placeholder="you@example.com"
          disabled
          class={`${inputClass} ${inputDisabledClass}`}
        />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with hidden label</h3>
        <Input
          type="email"
          placeholder="you@example.com"
          class={inputClass}
          aria-label="Email address"
        />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with corner hint</h3>
        <div class="relative">
          <Input type="email" placeholder="you@example.com" class={inputClass} />
          <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
            <HelpCircle class="h-4 w-4 text-gray-400" aria-hidden="true" />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with leading icon</h3>
        <div class="relative">
          <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <Mail class="h-4 w-4 text-gray-400" aria-hidden="true" />
          </div>
          <Input type="email" placeholder="you@example.com" class={`${inputClass} pl-10`} />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with trailing icon</h3>
        <div class="relative">
          <Input type="email" placeholder="you@example.com" class={inputClass} />
          <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
            <AlertCircle class="h-4 w-4 text-gray-400" aria-hidden="true" />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with add-on</h3>
        <InputGroup class="flex">
          <InputAddon class="rounded-none rounded-l-md bg-gray-50 px-3 py-1.5 text-sm text-gray-500 border border-r-0 border-gray-300 dark:bg-white/5 dark:text-gray-400 dark:border-white/10">
            https://
          </InputAddon>
          <Input
            type="text"
            placeholder="www.example.com"
            class="rounded-none rounded-l-md flex-1 border-l-0 focus:z-10"
          />
        </InputGroup>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input with inline add-on</h3>
        <InputGroup class="flex">
          <InputAddon class="rounded-none rounded-l-md bg-gray-50 px-3 py-1.5 text-sm text-gray-500 border border-r-0 border-gray-300 dark:bg-white/5 dark:text-gray-400 dark:border-white/10">
            @
          </InputAddon>
          <Input
            type="text"
            placeholder="username"
            class="rounded-none rounded-l-md flex-1 border-l-0 focus:z-10"
          />
        </InputGroup>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Input with inline leading and trailing add-ons
        </h3>
        <InputGroup class="flex">
          <InputAddon class="rounded-none rounded-l-md bg-gray-50 px-3 py-1.5 text-sm text-gray-500 border border-r-0 border-gray-300 dark:bg-white/5 dark:text-gray-400 dark:border-white/10">
            $
          </InputAddon>
          <Input type="text" placeholder="0.00" class="rounded-none flex-1 border-x-0 focus:z-10" />
          <InputAddon class="rounded-none rounded-r-md bg-gray-50 px-3 py-1.5 text-sm text-gray-500 border border-l-0 border-gray-300 dark:bg-white/5 dark:text-gray-400 dark:border-white/10">
            USD
          </InputAddon>
        </InputGroup>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Input with inline leading dropdown
        </h3>
        <InputGroup class="flex">
          <Select class="rounded-none rounded-l-md bg-gray-50 border border-r-0 border-gray-300 px-3 py-1.5 text-sm text-gray-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-white/5 dark:text-gray-400 dark:border-white/10 appearance-none cursor-pointer">
            <option value="usd">USD</option>
            <option value="eur">EUR</option>
            <option value="gbp">GBP</option>
          </Select>
          <Input
            type="text"
            placeholder="0.00"
            class="rounded-none rounded-l-md flex-1 border-l-0 focus:z-10"
          />
        </InputGroup>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Input with inline leading add-on and trailing dropdown
        </h3>
        <InputGroup class="flex">
          <InputAddon class="rounded-none rounded-l-md bg-gray-50 px-3 py-1.5 text-sm text-gray-500 border border-r-0 border-gray-300 dark:bg-white/5 dark:text-gray-400 dark:border-white/10">
            +1
          </InputAddon>
          <Input
            type="text"
            placeholder="(555) 000-0000"
            class="rounded-none flex-1 border-x-0 focus:z-10"
          />
          <Select class="rounded-none rounded-r-md bg-gray-50 border border-l-0 border-gray-300 px-3 py-1.5 text-sm text-gray-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-white/5 dark:text-gray-400 dark:border-white/10 appearance-none cursor-pointer">
            <option value="mobile">Mobile</option>
            <option value="home">Home</option>
            <option value="work">Work</option>
          </Select>
        </InputGroup>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Input with leading icon and trailing button
        </h3>
        <InputGroup class="flex relative">
          <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 z-10">
            <Users class="h-4 w-4 text-gray-400" aria-hidden="true" />
          </div>
          <Input type="text" placeholder="Search by username" class="pl-10" />
          <button
            type="button"
            class="rounded-none rounded-r-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 cursor-pointer"
          >
            Sort
          </button>
        </InputGroup>
      </div>
    </div>
  );
}
