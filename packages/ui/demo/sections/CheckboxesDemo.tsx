const checkboxInputClass =
  'col-start-1 row-start-1 size-5 appearance-none rounded border border-gray-300 bg-white checked:border-indigo-600 checked:bg-indigo-600 indeterminate:border-indigo-600 indeterminate:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:checked:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:indeterminate:border-indigo-500 dark:indeterminate:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:checked:bg-white/10 forced-colors:appearance-auto';

const checkedSvgClass =
  'pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white peer-checked:opacity-100 peer-indeterminate:opacity-0 opacity-0 transition-opacity';

const indeterminateSvgClass =
  'pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white peer-checked:opacity-0 peer-indeterminate:opacity-100 opacity-0 transition-opacity';

function Checkbox({
  id,
  name,
  label,
  description,
  defaultChecked = false,
  wrapperClass = '',
}: {
  id: string;
  name: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  wrapperClass?: string;
}) {
  return (
    <div class={`flex items-start gap-3 ${wrapperClass}`}>
      <div class="relative grid size-5 grid-cols-1 place-content-center">
        <input
          type="checkbox"
          id={id}
          name={name}
          defaultChecked={defaultChecked}
          class={`peer ${checkboxInputClass}`}
        />
        <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
          <path
            d="M3 7l3 3 5-5"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
          <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </div>
      <div class="min-w-0 flex-1">
        <label for={id} class="text-sm font-medium text-gray-900 dark:text-white">
          {label}
        </label>
        {description && <p class="text-xs text-gray-500 dark:text-gray-400">{description}</p>}
      </div>
    </div>
  );
}

export function CheckboxesDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with description</h3>
        <fieldset class="space-y-4">
          <legend class="sr-only">Notifications</legend>
          <Checkbox
            id="comments"
            name="comments"
            label="New comments"
            description="Get notified when someone posts a comment on a posting."
            defaultChecked={true}
          />
          <Checkbox
            id="candidates"
            name="candidates"
            label="New candidates"
            description="Get notified when a candidate applies for a job."
          />
          <Checkbox
            id="offers"
            name="offers"
            label="Offers"
            description="Get notified when a candidate accepts or rejects an offer."
          />
        </fieldset>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with inline description</h3>
        <fieldset class="space-y-0 divide-y divide-gray-200 dark:divide-white/10">
          <legend class="sr-only">Notifications</legend>
          <div class="py-4 first:pt-0 last:pb-0">
            <Checkbox
              id="comments-inline"
              name="comments-inline"
              label="New comments"
              description="Get notified when someone posts a comment on a posting."
              defaultChecked={true}
              wrapperClass="pt-4 first:pt-0"
            />
          </div>
          <div class="py-4">
            <Checkbox
              id="candidates-inline"
              name="candidates-inline"
              label="New candidates"
              description="Get notified when a candidate applies for a job."
            />
          </div>
          <div class="py-4 last:pb-0">
            <Checkbox
              id="offers-inline"
              name="offers-inline"
              label="Offers"
              description="Get notified when a candidate accepts or rejects an offer."
            />
          </div>
        </fieldset>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List with checkbox on right</h3>
        <fieldset class="space-y-0 divide-y divide-gray-200 dark:divide-white/10">
          <legend class="sr-only">Notifications</legend>
          <div class="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
            <div class="min-w-32">
              <span class="text-sm font-medium text-gray-900 dark:text-white">New comments</span>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Get notified when someone posts a comment on a posting.
              </p>
            </div>
            <div class="flex items-center gap-3 sm:ml-auto">
              <div class="relative grid size-5 grid-cols-1 place-content-center">
                <input
                  type="checkbox"
                  id="comments-right"
                  name="comments-right"
                  defaultChecked
                  class={`peer ${checkboxInputClass}`}
                />
                <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                  <path
                    d="M3 7l3 3 5-5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                  <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>
          <div class="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:gap-6">
            <div class="min-w-32">
              <span class="text-sm font-medium text-gray-900 dark:text-white">New candidates</span>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Get notified when a candidate applies for a job.
              </p>
            </div>
            <div class="flex items-center gap-3 sm:ml-auto">
              <div class="relative grid size-5 grid-cols-1 place-content-center">
                <input
                  type="checkbox"
                  id="candidates-right"
                  name="candidates-right"
                  class={`peer ${checkboxInputClass}`}
                />
                <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                  <path
                    d="M3 7l3 3 5-5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                  <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>
          <div class="flex flex-col gap-4 py-4 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
            <div class="min-w-32">
              <span class="text-sm font-medium text-gray-900 dark:text-white">Offers</span>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Get notified when a candidate accepts or rejects an offer.
              </p>
            </div>
            <div class="flex items-center gap-3 sm:ml-auto">
              <div class="relative grid size-5 grid-cols-1 place-content-center">
                <input
                  type="checkbox"
                  id="offers-right"
                  name="offers-right"
                  class={`peer ${checkboxInputClass}`}
                />
                <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                  <path
                    d="M3 7l3 3 5-5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                  <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </div>
            </div>
          </div>
        </fieldset>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple list with heading</h3>
        <fieldset class="space-y-4">
          <legend class="text-sm font-medium text-gray-900 dark:text-white mb-3">Members</legend>
          <div class="relative flex items-start gap-3">
            <div class="relative grid size-5 grid-cols-1 place-content-center">
              <input
                type="checkbox"
                id="member-1"
                name="member-1"
                defaultChecked
                class={`peer ${checkboxInputClass}`}
              />
              <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                <path
                  d="M3 7l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </div>
            <label for="member-1" class="text-sm text-gray-700 dark:text-gray-300">
              Alex Ferguson
            </label>
          </div>
          <div class="relative flex items-start gap-3">
            <div class="relative grid size-5 grid-cols-1 place-content-center">
              <input
                type="checkbox"
                id="member-2"
                name="member-2"
                defaultChecked
                class={`peer ${checkboxInputClass}`}
              />
              <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                <path
                  d="M3 7l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </div>
            <label for="member-2" class="text-sm text-gray-700 dark:text-gray-300">
              José Mourinho
            </label>
          </div>
          <div class="relative flex items-start gap-3">
            <div class="relative grid size-5 grid-cols-1 place-content-center">
              <input
                type="checkbox"
                id="member-3"
                name="member-3"
                class={`peer ${checkboxInputClass}`}
              />
              <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                <path
                  d="M3 7l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </div>
            <label for="member-3" class="text-sm text-gray-700 dark:text-gray-300">
              Arsène Wenger
            </label>
          </div>
          <div class="relative flex items-start gap-3">
            <div class="relative grid size-5 grid-cols-1 place-content-center">
              <input
                type="checkbox"
                id="member-4"
                name="member-4"
                class={`peer ${checkboxInputClass}`}
              />
              <svg viewBox="0 0 14 14" fill="none" class={checkedSvgClass}>
                <path
                  d="M3 7l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg viewBox="0 0 14 14" fill="none" class={indeterminateSvgClass}>
                <path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </div>
            <label for="member-4" class="text-sm text-gray-700 dark:text-gray-300">
              Diana Ross
            </label>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
