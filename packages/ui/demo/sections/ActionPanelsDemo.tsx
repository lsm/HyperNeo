import { useState } from 'preact/hooks';
import { Button, Input, Switch } from '../../src/mod.ts';
import { Check, CreditCard } from 'lucide-preact';

const cardClass =
  'bg-white shadow-sm sm:rounded-lg dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10';

const primaryBtnClass =
  'inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500';

const secondaryBtnClass =
  'inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-gray-700 dark:text-white dark:shadow-none dark:ring-gray-600 dark:hover:bg-gray-600';

const linkClass =
  'text-sm font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300';

const inputClass =
  'block w-full rounded-md border-0 py-2 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm dark:bg-gray-800 dark:text-white dark:ring-gray-600 dark:placeholder:text-gray-500';

const wellClass = 'rounded-lg bg-gray-100 p-4 dark:bg-gray-800/50';

function Toggle({ defaultChecked = false }: { defaultChecked?: boolean }) {
  return (
    <Switch
      defaultChecked={defaultChecked}
      class="group relative inline-flex h-6 w-11 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out data-[checked]:bg-indigo-600 data-[focus]:ring-2 data-[focus]:ring-indigo-600 data-[focus]:ring-offset-2 data-[focus]:ring-offset-white dark:bg-white/5 dark:inset-ring-white/10 dark:outline-indigo-500 dark:data-[checked]:bg-indigo-500 forced-colors:appearance-auto"
    >
      {(slot: { checked: boolean }) => (
        <span
          aria-hidden="true"
          class={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-colors duration-200 ease-in-out ${slot.checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      )}
    </Switch>
  );
}

function Example1() {
  return (
    <div class={`${cardClass} p-4`}>
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Archive settings</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Automatically archive inactive projects after 30 days of inactivity.
          </p>
        </div>
        <Button class={primaryBtnClass}>Save</Button>
      </div>
    </div>
  );
}

function Example2() {
  return (
    <div class={`${cardClass} p-4`}>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Billing</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Manage your billing settings, including your payment method and subscription.
      </p>
      <div class="mt-4">
        <a href="#billing" class={linkClass}>
          Learn more
          <span aria-hidden="true"> →</span>
        </a>
      </div>
    </div>
  );
}

function Example3() {
  return (
    <div class={`${cardClass} p-4`}>
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
            Span Mode for all sessions
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            When enabled, new sessions will use Span Mode by default.
          </p>
        </div>
        <Button class={secondaryBtnClass}>Configure</Button>
      </div>
    </div>
  );
}

function Example4() {
  return (
    <div class={`${cardClass} p-0 sm:p-4`}>
      <div class="flex items-start justify-between p-4 sm:p-0">
        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">API Keys</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage your API keys for accessing the developer platform.
          </p>
        </div>
        <Button class={secondaryBtnClass}>Create new key</Button>
      </div>
    </div>
  );
}

function Example5() {
  return (
    <div class={`${cardClass} p-4`}>
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Renew subscription</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Automatically renew your subscription when it expires.
          </p>
        </div>
        <Toggle defaultChecked={true} />
      </div>
    </div>
  );
}

function Example6() {
  const [email, setEmail] = useState('alex@company.com');

  return (
    <div class={`${cardClass} p-4`}>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Email notifications</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Receive email updates about your account activity.
      </p>
      <div class="mt-4 flex items-center gap-3">
        <Input
          type="email"
          value={email}
          onChange={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
          class={inputClass}
        />
        <Button class={primaryBtnClass}>Save</Button>
      </div>
    </div>
  );
}

function Example7() {
  return (
    <div class={wellClass}>
      <div class="flex items-center gap-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-white dark:bg-gray-700">
          <CreditCard class="h-6 w-6 text-gray-400" aria-hidden="true" />
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-gray-900 dark:text-white">Visa ending in 4242</span>
          <span class="rounded-md bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
            Active
          </span>
        </div>
      </div>
    </div>
  );
}

function Example8() {
  return (
    <div class={`${cardClass} p-4`}>
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Marketing emails</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Receive emails about new features and product updates.
          </p>
        </div>
      </div>
      <div class={`mt-4 rounded-lg bg-gray-100 p-4 dark:bg-gray-800/50`}>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <Toggle defaultChecked={true} />
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">Product updates</p>
              <p class="text-xs text-gray-500 dark:text-gray-400">Monthly digest of new features</p>
            </div>
          </div>
          <Check class="h-5 w-5 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

export function ActionPanelsDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple panel</h3>
        <Example1 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With link</h3>
        <Example2 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With button on right</h3>
        <Example3 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With button at top-right</h3>
        <Example4 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With toggle</h3>
        <Example5 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With input</h3>
        <Example6 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple well</h3>
        <Example7 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With well</h3>
        <Example8 />
      </div>
    </div>
  );
}
