import { useState } from 'preact/hooks';
import { Checkbox } from '../../src/mod.ts';

function CheckIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" class="w-3 h-3">
      <path
        d="M3 7l3 3 5-5"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" class="w-3 h-3">
      <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

export function CheckboxDemo() {
  const [checked, setChecked] = useState(false);

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Basic (uncontrolled)</h3>
        <Checkbox
          defaultChecked={false}
          class="inline-flex items-center justify-center w-5 h-5 rounded border border-surface-border bg-surface-2 cursor-pointer transition-all data-[checked]:bg-accent-500 data-[checked]:border-accent-500 data-[focus]:ring-2 data-[focus]:ring-accent-500 data-[focus]:outline-none data-[hover]:border-accent-400"
        >
          {(slot: { checked: boolean }) => (
            <span class={`text-white ${slot.checked ? 'block' : 'hidden'}`}>
              <CheckIcon />
            </span>
          )}
        </Checkbox>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Controlled with label</h3>
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <Checkbox
            checked={checked}
            onChange={setChecked}
            class="inline-flex items-center justify-center w-5 h-5 rounded border border-surface-border bg-surface-2 cursor-pointer transition-all data-[checked]:bg-accent-500 data-[checked]:border-accent-500 data-[focus]:ring-2 data-[focus]:ring-accent-500 data-[focus]:outline-none data-[hover]:border-accent-400"
          >
            {(slot: { checked: boolean }) => (
              <span class={`text-white ${slot.checked ? 'block' : 'hidden'}`}>
                <CheckIcon />
              </span>
            )}
          </Checkbox>
          <span class="text-text-primary text-sm">
            {checked ? 'Checked' : 'Unchecked'} — click to toggle
          </span>
        </label>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Indeterminate state</h3>
        <label class="flex items-center gap-3 select-none">
          <Checkbox
            indeterminate={true}
            class="inline-flex items-center justify-center w-5 h-5 rounded border border-surface-border bg-surface-2 cursor-pointer transition-all data-[checked]:bg-accent-500 data-[checked]:border-accent-500 data-[indeterminate]:bg-accent-500 data-[indeterminate]:border-accent-500 data-[focus]:ring-2 data-[focus]:ring-accent-500 data-[focus]:outline-none data-[hover]:border-accent-400"
          >
            {(slot: { checked: boolean; indeterminate: boolean }) => (
              <span
                class={`text-white ${slot.indeterminate ? 'block' : slot.checked ? 'block' : 'hidden'}`}
              >
                {slot.indeterminate ? <DashIcon /> : <CheckIcon />}
              </span>
            )}
          </Checkbox>
          <span class="text-text-primary text-sm">Indeterminate</span>
        </label>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Disabled</h3>
        <div class="flex items-center gap-6">
          <label class="flex items-center gap-3 select-none opacity-50 cursor-not-allowed">
            <Checkbox
              disabled
              class="inline-flex items-center justify-center w-5 h-5 rounded border border-surface-border bg-surface-2 cursor-not-allowed transition-all"
            >
              {() => null}
            </Checkbox>
            <span class="text-text-secondary text-sm">Disabled unchecked</span>
          </label>

          <label class="flex items-center gap-3 select-none opacity-50 cursor-not-allowed">
            <Checkbox
              disabled
              defaultChecked={true}
              class="inline-flex items-center justify-center w-5 h-5 rounded border border-accent-500 bg-accent-500 cursor-not-allowed transition-all"
            >
              {(slot: { checked: boolean }) => (
                <span class={`text-white ${slot.checked ? 'block' : 'hidden'}`}>
                  <CheckIcon />
                </span>
              )}
            </Checkbox>
            <span class="text-text-secondary text-sm">Disabled checked</span>
          </label>
        </div>
      </div>
    </div>
  );
}
