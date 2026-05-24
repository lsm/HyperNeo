import { useState } from 'preact/hooks';
import { Switch } from '../../src/mod.ts';

interface StyledSwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  name?: string;
}

function StyledSwitch({ checked, defaultChecked, onChange, disabled, name }: StyledSwitchProps) {
  return (
    <Switch
      checked={checked}
      defaultChecked={defaultChecked}
      onChange={onChange}
      disabled={disabled}
      name={name}
      class="relative inline-flex h-6 w-11 items-center rounded-full border-2 border-transparent transition-colors cursor-pointer focus:outline-none bg-surface-3 data-[checked]:bg-accent-500 data-[focus]:ring-2 data-[focus]:ring-accent-500 data-[focus]:ring-offset-2 data-[focus]:ring-offset-surface-1 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {(slot: { checked: boolean }) => (
        <span
          class={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${slot.checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      )}
    </Switch>
  );
}

export function SwitchDemo() {
  const [enabled, setEnabled] = useState(false);
  const [notifications, setNotifications] = useState(true);

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Basic (uncontrolled)</h3>
        <StyledSwitch defaultChecked={false} />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Controlled with label</h3>
        <label class="flex items-center gap-4 cursor-pointer select-none">
          <StyledSwitch checked={enabled} onChange={setEnabled} />
          <span class="text-text-primary text-sm">{enabled ? 'On' : 'Off'} — click to toggle</span>
        </label>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          With name prop (form integration)
        </h3>
        <form class="flex items-center gap-4">
          <StyledSwitch checked={notifications} onChange={setNotifications} name="notifications" />
          <span class="text-text-primary text-sm">
            Email notifications:{' '}
            <strong class="text-text-primary">{notifications ? 'enabled' : 'disabled'}</strong>
          </span>
        </form>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Disabled</h3>
        <div class="flex items-center gap-8">
          <label class="flex items-center gap-3 select-none">
            <StyledSwitch disabled defaultChecked={false} />
            <span class="text-text-tertiary text-sm">Disabled off</span>
          </label>
          <label class="flex items-center gap-3 select-none">
            <StyledSwitch disabled defaultChecked={true} />
            <span class="text-text-tertiary text-sm">Disabled on</span>
          </label>
        </div>
      </div>
    </div>
  );
}
