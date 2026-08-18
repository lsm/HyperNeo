import { Input, InputGroup, InputAddon } from '../../../../src/mod.ts';
import { Mail, User, Image, Lock, Phone, MapPin, Calendar } from 'lucide-preact';

const inputClass =
  'bg-surface-2 border border-surface-border rounded-lg px-3 py-2 text-text-primary placeholder-text-muted transition-colors w-full focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 disabled:opacity-50 disabled:cursor-not-allowed';

const addonClass = 'flex items-center justify-center px-3 text-text-tertiary';

export function FormLayoutsDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Stacked form with leading icons</h3>
        <div class="bg-surface-0 border border-surface-border rounded-xl p-6 space-y-6">
          <div>
            <label for="username" class="block text-sm font-medium text-text-primary mb-2">
              Username
            </label>
            <InputGroup>
              <InputAddon class={addonClass}>
                <User class="size-5" />
              </InputAddon>
              <Input id="username" type="text" placeholder="janesmith" class={inputClass} />
            </InputGroup>
          </div>

          <div>
            <label for="email" class="block text-sm font-medium text-text-primary mb-2">
              Email
            </label>
            <InputGroup>
              <InputAddon class={addonClass}>
                <Mail class="size-5" />
              </InputAddon>
              <Input id="email" type="email" placeholder="jane@example.com" class={inputClass} />
            </InputGroup>
          </div>

          <div>
            <label for="phone" class="block text-sm font-medium text-text-primary mb-2">
              Phone
            </label>
            <InputGroup>
              <InputAddon class={addonClass}>
                <Phone class="size-5" />
              </InputAddon>
              <Input id="phone" type="tel" placeholder="+1 (555) 000-0000" class={inputClass} />
            </InputGroup>
          </div>

          <div>
            <label for="password" class="block text-sm font-medium text-text-primary mb-2">
              Password
            </label>
            <InputGroup>
              <InputAddon class={addonClass}>
                <Lock class="size-5" />
              </InputAddon>
              <Input
                id="password"
                type="password"
                placeholder="Enter password"
                class={inputClass}
              />
            </InputGroup>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Two-column form with icon inputs
        </h3>
        <div class="bg-surface-0 border border-surface-border rounded-xl p-6">
          <div class="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2">
            <div>
              <label for="first-name" class="block text-sm font-medium text-text-primary mb-2">
                First name
              </label>
              <InputGroup>
                <InputAddon class={addonClass}>
                  <User class="size-5" />
                </InputAddon>
                <Input id="first-name" type="text" placeholder="Jane" class={inputClass} />
              </InputGroup>
            </div>

            <div>
              <label for="last-name" class="block text-sm font-medium text-text-primary mb-2">
                Last name
              </label>
              <InputGroup>
                <InputAddon class={addonClass}>
                  <User class="size-5" />
                </InputAddon>
                <Input id="last-name" type="text" placeholder="Smith" class={inputClass} />
              </InputGroup>
            </div>

            <div class="sm:col-span-2">
              <label for="email-2" class="block text-sm font-medium text-text-primary mb-2">
                Email address
              </label>
              <InputGroup>
                <InputAddon class={addonClass}>
                  <Mail class="size-5" />
                </InputAddon>
                <Input
                  id="email-2"
                  type="email"
                  placeholder="jane.smith@example.com"
                  class={inputClass}
                />
              </InputGroup>
            </div>

            <div>
              <label for="phone-2" class="block text-sm font-medium text-text-primary mb-2">
                Phone
              </label>
              <InputGroup>
                <InputAddon class={addonClass}>
                  <Phone class="size-5" />
                </InputAddon>
                <Input id="phone-2" type="tel" placeholder="+1 (555) 000-0000" class={inputClass} />
              </InputGroup>
            </div>

            <div>
              <label for="appointment" class="block text-sm font-medium text-text-primary mb-2">
                Appointment date
              </label>
              <InputGroup>
                <InputAddon class={addonClass}>
                  <Calendar class="size-5" />
                </InputAddon>
                <Input id="appointment" type="date" class={inputClass} />
              </InputGroup>
            </div>

            <div class="sm:col-span-2">
              <label for="street" class="block text-sm font-medium text-text-primary mb-2">
                Street address
              </label>
              <InputGroup>
                <InputAddon class={addonClass}>
                  <MapPin class="size-5" />
                </InputAddon>
                <Input id="street" type="text" placeholder="123 Main St" class={inputClass} />
              </InputGroup>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Form with photo upload</h3>
        <div class="bg-surface-0 border border-surface-border rounded-xl p-6">
          <div class="space-y-6">
            <div>
              <label class="block text-sm font-medium text-text-primary mb-2">Profile photo</label>
              <div class="mt-2 flex items-center gap-x-3">
                <div class="size-12 rounded-full bg-surface-2 flex items-center justify-center text-text-tertiary">
                  <User class="size-6" />
                </div>
                <button
                  type="button"
                  class="rounded-lg bg-surface-2 border border-surface-border px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-3 transition-colors"
                >
                  Change
                </button>
              </div>
            </div>

            <div>
              <label class="block text-sm font-medium text-text-primary mb-2">Cover photo</label>
              <div class="mt-2 flex justify-center rounded-lg border border-dashed border-surface-border px-6 py-10">
                <div class="text-center">
                  <Image class="mx-auto size-12 text-text-muted" />
                  <div class="mt-4 flex text-sm text-text-secondary">
                    <label
                      for="file-upload"
                      class="relative cursor-pointer rounded-md bg-transparent font-medium text-accent-400 hover:text-accent-300 focus-within:outline-none focus-within:ring-2 focus-within:ring-accent-500 focus-within:ring-offset-2"
                    >
                      <span>Upload a file</span>
                      <input id="file-upload" name="file-upload" type="file" class="sr-only" />
                    </label>
                    <p class="pl-1">or drag and drop</p>
                  </div>
                  <p class="text-xs text-text-muted">PNG, JPG, GIF up to 10MB</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
