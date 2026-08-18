import { useState } from 'preact/hooks';
import { Radio, RadioGroup } from '../../src/mod.ts';

const plans = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$9/mo',
    description: 'Perfect for side projects and small apps.',
  },
  {
    id: 'business',
    name: 'Business',
    price: '$29/mo',
    description: 'For growing teams with advanced needs.',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: '$99/mo',
    description: 'Dedicated support and custom integrations.',
  },
  {
    id: 'legacy',
    name: 'Legacy',
    price: '$5/mo',
    description: 'No longer available for new sign-ups.',
    disabled: true,
  },
];

export function RadioGroupDemo() {
  const [selected, setSelected] = useState('business');

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Plan selector</h3>
        <RadioGroup value={selected} onChange={setSelected} class="space-y-3">
          {plans.map((plan) => (
            <Radio
              key={plan.id}
              value={plan.id}
              disabled={plan.disabled}
              class="flex items-start gap-4 p-4 rounded-lg border border-surface-border bg-surface-2 cursor-pointer transition-all select-none data-[checked]:border-accent-500 data-[checked]:bg-surface-3 data-[checked]:ring-1 data-[checked]:ring-accent-500 data-[hover]:border-surface-border data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
            >
              {(slot: { checked: boolean }) => (
                <>
                  <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-surface-border transition-colors data-[checked]:border-accent-500">
                    {slot.checked && <span class="h-2 w-2 rounded-full bg-accent-500" />}
                  </span>

                  <span class="flex flex-1 flex-col">
                    <span class="text-sm font-medium text-text-primary">{plan.name}</span>
                    <span class="text-xs text-text-tertiary mt-0.5">{plan.description}</span>
                  </span>

                  <span class="text-sm font-semibold text-text-secondary">{plan.price}</span>
                </>
              )}
            </Radio>
          ))}
        </RadioGroup>
      </div>

      <div>
        <p class="text-sm text-text-tertiary">
          Selected plan: <span class="text-accent-400 font-medium">{selected}</span>
        </p>
      </div>
    </div>
  );
}
