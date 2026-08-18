import { CheckCircle } from 'lucide-preact';

const radioInputClass =
  'relative size-4 appearance-none rounded-full border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 forced-colors:appearance-auto';

function Example1() {
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Notifications
      </legend>
      <div class="space-y-2">
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="radio"
            name="notifications"
            value="email"
            defaultChecked
            class={radioInputClass}
          />
          <span class="text-sm text-gray-900 dark:text-white">Email</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <input type="radio" name="notifications" value="sms" class={radioInputClass} />
          <span class="text-sm text-gray-900 dark:text-white">SMS</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <input type="radio" name="notifications" value="push" class={radioInputClass} />
          <span class="text-sm text-gray-900 dark:text-white">Push notification</span>
        </label>
      </div>
    </fieldset>
  );
}

function Example2() {
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Notifications
      </legend>
      <div class="flex items-center gap-6">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="radio"
            name="notifications-inline"
            value="email"
            defaultChecked
            class={radioInputClass}
          />
          <span class="text-sm text-gray-900 dark:text-white">Email</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input type="radio" name="notifications-inline" value="sms" class={radioInputClass} />
          <span class="text-sm text-gray-900 dark:text-white">SMS</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input type="radio" name="notifications-inline" value="push" class={radioInputClass} />
          <span class="text-sm text-gray-900 dark:text-white">Push</span>
        </label>
      </div>
    </fieldset>
  );
}

function Example3() {
  const plans = [
    { id: '2gb', label: '2 GB RAM', description: '8 CPUs, 50GB SSD' },
    { id: '4gb', label: '4 GB RAM', description: '16 CPUs, 100GB SSD' },
    { id: '8gb', label: '8 GB RAM', description: '32 CPUs, 200GB SSD' },
  ];
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Select a plan
      </legend>
      <div class="space-y-3">
        {plans.map((plan) => (
          <label
            key={plan.id}
            class="flex items-start gap-3 cursor-pointer select-none p-3 rounded-lg border border-gray-200 hover:border-gray-300 dark:border-white/10 dark:hover:border-white/20"
          >
            <input
              type="radio"
              name="plan"
              value={plan.id}
              defaultChecked={plan.id === '2gb'}
              class={`mt-0.5 ${radioInputClass}`}
            />
            <div>
              <span class="text-sm font-medium text-gray-900 dark:text-white block">
                {plan.label}
              </span>
              <span class="text-xs text-gray-500 dark:text-gray-400">{plan.description}</span>
            </div>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Example4() {
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Privacy setting
      </legend>
      <div class="space-y-2">
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="radio"
            name="privacy"
            value="public"
            defaultChecked
            class={radioInputClass}
          />
          <div>
            <span class="text-sm text-gray-900 dark:text-white">Public</span>
            <span class="text-sm text-gray-500 dark:text-gray-400 ml-2">
              Visible to anyone on the internet
            </span>
          </div>
        </label>
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <input type="radio" name="privacy" value="private" class={radioInputClass} />
          <div>
            <span class="text-sm text-gray-900 dark:text-white">Private</span>
            <span class="text-sm text-gray-500 dark:text-gray-400 ml-2">
              Only visible to team members
            </span>
          </div>
        </label>
      </div>
    </fieldset>
  );
}

function Example5() {
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">Sort by</legend>
      <div class="space-y-2">
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <div>
            <span class="text-sm text-gray-900 dark:text-white block">Newest</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">Most recent activity</span>
          </div>
          <input
            type="radio"
            name="sort"
            value="newest"
            defaultChecked
            class={`ml-auto ${radioInputClass}`}
          />
        </label>
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <div>
            <span class="text-sm text-gray-900 dark:text-white block">Oldest</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">First activity</span>
          </div>
          <input type="radio" name="sort" value="oldest" class={`ml-auto ${radioInputClass}`} />
        </label>
      </div>
    </fieldset>
  );
}

function Example6() {
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Transfer frequency
      </legend>
      <div class="space-y-2">
        <label class="flex items-center gap-3 cursor-pointer select-none p-3 rounded-lg border border-gray-200 hover:border-gray-300 dark:border-white/10 dark:hover:border-white/20">
          <span class="text-sm text-gray-900 dark:text-white">Daily</span>
          <input type="radio" name="frequency" value="daily" class={`ml-auto ${radioInputClass}`} />
        </label>
        <label class="flex items-center gap-3 cursor-pointer select-none p-3 rounded-lg border border-gray-200 hover:border-gray-300 dark:border-white/10 dark:hover:border-white/20">
          <span class="text-sm text-gray-900 dark:text-white">Weekly</span>
          <input
            type="radio"
            name="frequency"
            value="weekly"
            defaultChecked
            class={`ml-auto ${radioInputClass}`}
          />
        </label>
        <label class="flex items-center gap-3 cursor-pointer select-none p-3 rounded-lg border border-gray-200 hover:border-gray-300 dark:border-white/10 dark:hover:border-white/20">
          <span class="text-sm text-gray-900 dark:text-white">Monthly</span>
          <input
            type="radio"
            name="frequency"
            value="monthly"
            class={`ml-auto ${radioInputClass}`}
          />
        </label>
      </div>
    </fieldset>
  );
}

function Example7() {
  return (
    <table class="w-full text-sm text-left">
      <tbody class="divide-y divide-gray-100 dark:divide-white/10">
        <tr class="hover:bg-gray-50 dark:hover:bg-white/5">
          <td class="py-3 px-4 font-medium text-gray-900 dark:text-white">Email</td>
          <td class="py-3 px-4 text-gray-500 dark:text-gray-400">andy@example.com</td>
          <td class="py-3 px-4 text-right">
            <input
              type="radio"
              name="contact"
              value="email"
              defaultChecked
              class="inline-flex justify-end checked:bg-indigo-600 checked:border-indigo-600 dark:checked:bg-indigo-500 dark:checked:border-indigo-500"
            />
          </td>
        </tr>
        <tr class="hover:bg-gray-50 dark:hover:bg-white/5">
          <td class="py-3 px-4 font-medium text-gray-900 dark:text-white">SMS</td>
          <td class="py-3 px-4 text-gray-500 dark:text-gray-400">+1 (555) 123-4567</td>
          <td class="py-3 px-4 text-right">
            <input
              type="radio"
              name="contact"
              value="sms"
              class="inline-flex justify-end checked:bg-indigo-600 checked:border-indigo-600 dark:checked:bg-indigo-500 dark:checked:border-indigo-500"
            />
          </td>
        </tr>
        <tr class="hover:bg-gray-50 dark:hover:bg-white/5">
          <td class="py-3 px-4 font-medium text-gray-900 dark:text-white">Push</td>
          <td class="py-3 px-4 text-gray-500 dark:text-gray-400">Smartphone</td>
          <td class="py-3 px-4 text-right">
            <input
              type="radio"
              name="contact"
              value="push"
              class="inline-flex justify-end checked:bg-indigo-600 checked:border-indigo-600 dark:checked:bg-indigo-500 dark:checked:border-indigo-500"
            />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Example8() {
  return (
    <fieldset class="border border-gray-200 dark:border-white/10 rounded-lg p-4">
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Background Sync
      </legend>
      <div class="space-y-2">
        <label class="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="radio"
            name="sync"
            value="all"
            defaultChecked
            class={`mt-0.5 ${radioInputClass}`}
          />
          <div>
            <span class="text-sm font-medium text-gray-900 dark:text-white block">
              Allow all Background Sync
            </span>
            <span class="text-xs text-gray-500 dark:text-gray-400">
              Permit all background data syncs to run without restrictions
            </span>
          </div>
        </label>
        <label class="flex items-start gap-3 cursor-pointer select-none">
          <input type="radio" name="sync" value="wifi" class={`mt-0.5 ${radioInputClass}`} />
          <div>
            <span class="text-sm font-medium text-gray-900 dark:text-white block">Wi-Fi only</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">
              Only sync when connected to Wi-Fi to save mobile data
            </span>
          </div>
        </label>
        <label class="flex items-start gap-3 cursor-pointer select-none">
          <input type="radio" name="sync" value="never" class={`mt-0.5 ${radioInputClass}`} />
          <div>
            <span class="text-sm font-medium text-gray-900 dark:text-white block">Never</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">
              Background sync is disabled entirely
            </span>
          </div>
        </label>
      </div>
    </fieldset>
  );
}

function Example9() {
  const colors = [
    { id: 'pink', color: 'bg-pink-500' },
    { id: 'purple', color: 'bg-purple-500' },
    { id: 'blue', color: 'bg-blue-500' },
    { id: 'green', color: 'bg-green-500' },
    { id: 'yellow', color: 'bg-yellow-500' },
  ];
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Choose a label color
      </legend>
      <div class="flex items-center gap-3">
        {colors.map((c, i) => (
          <label
            key={c.id}
            class={`relative flex items-center justify-center w-8 h-8 rounded-full cursor-pointer ${c.color} ring-1 ring-black/10`}
          >
            <input
              type="radio"
              name="color"
              value={c.id}
              defaultChecked={i === 0}
              class="sr-only"
            />
            <span class="sr-only">{c.id}</span>
            {i === 0 && <CheckCircle class="w-5 h-5 text-white" />}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Example10() {
  const plans = [
    {
      id: 'starter',
      name: 'Starter',
      description: 'Perfect for small teams and projects',
      price: 'Free',
    },
    {
      id: 'standard',
      name: 'Standard',
      description: 'For growing teams with advanced needs',
      price: '$29/mo',
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      description: 'Dedicated support and custom integrations',
      price: '$99/mo',
    },
  ];
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Select a mailing list
      </legend>
      <div class="grid grid-cols-3 gap-4">
        {plans.map((plan, i) => (
          <label
            key={plan.id}
            class="relative flex flex-col p-4 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer dark:border-white/10 dark:hover:border-white/20"
          >
            <input
              type="radio"
              name="mailing-list"
              value={plan.id}
              defaultChecked={i === 0}
              class="sr-only"
            />
            <span class="text-sm font-medium text-gray-900 dark:text-white">{plan.name}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400 mt-1">{plan.description}</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-white mt-3">
              {plan.price}
            </span>
            {i === 0 && (
              <CheckCircle class="absolute top-4 right-4 w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Example11() {
  const options = [
    { id: '4gb', label: '4 GB', disabled: false },
    { id: '8gb', label: '8 GB', disabled: false },
    { id: '16gb', label: '16 GB', disabled: false },
    { id: '32gb', label: '32 GB', disabled: false },
    { id: '64gb', label: '64 GB', disabled: true },
    { id: '128gb', label: '128 GB', disabled: true },
  ];
  return (
    <fieldset>
      <legend class="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Choose a memory option
      </legend>
      <div class="grid grid-cols-3 gap-3">
        {options.map((opt, i) => (
          <label
            key={opt.id}
            class={`relative flex items-center justify-center p-3 rounded-lg border cursor-pointer ${
              opt.disabled
                ? 'border-gray-200 dark:border-white/10 opacity-50 cursor-not-allowed'
                : 'border-gray-200 hover:border-gray-300 dark:border-white/10 dark:hover:border-white/20'
            }`}
          >
            <input
              type="radio"
              name="memory"
              value={opt.id}
              disabled={opt.disabled}
              defaultChecked={i === 2}
              class="sr-only"
            />
            <span class="text-sm font-medium text-gray-900 dark:text-white uppercase">
              {opt.label}
            </span>
            {i === 2 && !opt.disabled && (
              <CheckCircle class="absolute top-2 right-2 w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function RadioGroupsDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple list</h3>
        <Example1 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple inline list</h3>
        <Example2 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with description</h3>
        <Example3 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with inline description</h3>
        <Example4 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with radio on right</h3>
        <Example5 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple list with radio on right</h3>
        <Example6 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple table</h3>
        <Example7 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with descriptions in panel</h3>
        <Example8 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Color picker</h3>
        <Example9 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Cards</h3>
        <Example10 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Small cards</h3>
        <Example11 />
      </div>
    </div>
  );
}
