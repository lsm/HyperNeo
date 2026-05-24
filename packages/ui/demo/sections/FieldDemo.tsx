import {
  Description,
  Field,
  Fieldset,
  Input,
  Label,
  Legend,
  Select,
  Textarea,
} from '../../src/mod.ts';

const inputClass =
  'bg-surface-2 border border-surface-border rounded-lg px-3 py-2 text-text-primary placeholder-text-muted transition-colors w-full focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 disabled:opacity-50 disabled:cursor-not-allowed';

export function FieldDemo() {
  return (
    <div class="space-y-8 max-w-md">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Field — Label + Input + Description (auto ARIA wiring)
        </h3>
        <Field class="space-y-1.5">
          <Label class="block text-sm font-medium text-text-primary">Email address</Label>
          <Input type="email" placeholder="you@example.com" class={inputClass} />
          <Description class="text-xs text-text-tertiary">
            We'll never share your email with anyone else.
          </Description>
        </Field>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Field — Textarea with description
        </h3>
        <Field class="space-y-1.5">
          <Label class="block text-sm font-medium text-text-primary">Bio</Label>
          <Textarea placeholder="Tell us about yourself..." rows={3} class={inputClass} />
          <Description class="text-xs text-text-tertiary">
            Max 200 characters. Shown on your public profile.
          </Description>
        </Field>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Fieldset — multiple fields</h3>
        <Fieldset class="border border-surface-border rounded-lg p-4 space-y-4">
          <Legend class="text-sm font-semibold text-text-primary px-1">Personal information</Legend>

          <Field class="space-y-1.5">
            <Label class="block text-sm font-medium text-text-secondary">First name</Label>
            <Input type="text" placeholder="Jane" class={inputClass} />
          </Field>

          <Field class="space-y-1.5">
            <Label class="block text-sm font-medium text-text-secondary">Last name</Label>
            <Input type="text" placeholder="Smith" class={inputClass} />
          </Field>

          <Field class="space-y-1.5">
            <Label class="block text-sm font-medium text-text-secondary">Country</Label>
            <Select class="bg-surface-2 border border-surface-border rounded-lg px-3 py-2 text-text-primary w-full focus:outline-none focus:ring-2 focus:ring-accent-500">
              <option value="">Select a country</option>
              <option value="us">United States</option>
              <option value="gb">United Kingdom</option>
              <option value="de">Germany</option>
            </Select>
          </Field>
        </Fieldset>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Disabled Fieldset — cascades disabled to all children
        </h3>
        <Fieldset disabled class="border border-surface-border rounded-lg p-4 space-y-4 opacity-60">
          <Legend class="text-sm font-semibold text-text-tertiary px-1">
            Account settings (locked)
          </Legend>

          <Field class="space-y-1.5">
            <Label class="block text-sm font-medium text-text-tertiary">Username</Label>
            <Input type="text" placeholder="username" class={inputClass} />
            <Description class="text-xs text-text-muted">
              Contact support to change your username.
            </Description>
          </Field>

          <Field class="space-y-1.5">
            <Label class="block text-sm font-medium text-text-tertiary">Plan</Label>
            <Select class="bg-surface-2 border border-surface-border rounded-lg px-3 py-2 text-text-tertiary w-full focus:outline-none cursor-not-allowed">
              <option value="pro">Pro</option>
              <option value="free">Free</option>
            </Select>
          </Field>
        </Fieldset>
      </div>
    </div>
  );
}
