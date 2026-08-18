import { CheckCircle, Info, X, XCircle, AlertTriangle } from 'lucide-preact';

export function AlertsDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With list</h3>
        <div class="rounded-md bg-red-50 p-4 dark:bg-red-500/15 dark:outline dark:outline-red-500/25">
          <div class="flex">
            <div class="shrink-0">
              <XCircle class="size-5 text-red-400" />
            </div>
            <div class="ml-3">
              <h3 class="text-sm font-medium text-red-800 dark:text-red-200">
                There were 2 errors with your submission
              </h3>
              <div class="mt-2 text-sm text-red-700 dark:text-red-200/80">
                <ul role="list" class="list-disc space-y-1 pl-5">
                  <li>Your password must be at least 8 characters</li>
                  <li>Your password must include at least one pro wrestling finishing move</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With dismiss button</h3>
        <div class="rounded-md bg-green-50 p-4 dark:bg-green-500/10 dark:outline dark:outline-green-500/20">
          <div class="flex">
            <div class="shrink-0">
              <CheckCircle class="size-5 text-green-400" />
            </div>
            <div class="ml-3">
              <p class="text-sm font-medium text-green-800 dark:text-green-300">
                Successfully uploaded
              </p>
            </div>
            <div class="ml-auto pl-3">
              <div class="-mx-1.5 -my-1.5">
                <button
                  type="button"
                  class="inline-flex rounded-md bg-green-50 p-1.5 text-green-500 hover:bg-green-100 focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-2 focus-visible:ring-offset-green-50 focus-visible:outline-hidden dark:bg-transparent dark:text-green-400 dark:hover:bg-green-500/10 dark:focus-visible:ring-green-500 dark:focus-visible:ring-offset-1 dark:focus-visible:ring-offset-green-900"
                >
                  <span class="sr-only">Dismiss</span>
                  <X class="size-5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With actions</h3>
        <div class="rounded-md bg-green-50 p-4 dark:bg-green-500/10 dark:outline dark:outline-green-500/20">
          <div class="flex">
            <div class="shrink-0">
              <CheckCircle class="size-5 text-green-400" />
            </div>
            <div class="ml-3">
              <h3 class="text-sm font-medium text-green-800 dark:text-green-200">
                Order completed
              </h3>
              <div class="mt-2 text-sm text-green-700 dark:text-green-200/85">
                <p>
                  Lorem ipsum dolor sit amet consectetur adipisicing elit. Aliquid pariatur, ipsum
                  similique veniam.
                </p>
              </div>
              <div class="mt-4">
                <div class="-mx-2 -my-1.5 flex">
                  <button
                    type="button"
                    class="rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 dark:bg-transparent dark:text-green-200 dark:hover:bg-white/10 dark:focus-visible:outline-offset-1 dark:focus-visible:outline-green-500/50"
                  >
                    View status
                  </button>
                  <button
                    type="button"
                    class="ml-3 rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 dark:bg-transparent dark:text-green-200 dark:hover:bg-white/10 dark:focus-visible:outline-offset-1 dark:focus-visible:outline-green-500/50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With description</h3>
        <div class="rounded-md bg-yellow-50 p-4 dark:bg-yellow-500/10 dark:outline dark:outline-yellow-500/15">
          <div class="flex">
            <div class="shrink-0">
              <AlertTriangle class="size-5 text-yellow-400 dark:text-yellow-300" />
            </div>
            <div class="ml-3">
              <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-100">
                Attention needed
              </h3>
              <div class="mt-2 text-sm text-yellow-700 dark:text-yellow-100/80">
                <p>
                  Lorem ipsum dolor sit amet consectetur adipisicing elit. Aliquid pariatur, ipsum
                  similique veniam quo totam eius aperiam dolorum.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With accent border</h3>
        <div class="border-l-4 border-yellow-400 bg-yellow-50 p-4 dark:border-yellow-500 dark:bg-yellow-500/10">
          <div class="flex">
            <div class="shrink-0">
              <AlertTriangle class="size-5 text-yellow-400 dark:text-yellow-500" />
            </div>
            <div class="ml-3">
              <p class="text-sm text-yellow-700 dark:text-yellow-300">
                You have no credits left.{' '}
                <a
                  href="#"
                  class="font-medium text-yellow-700 underline hover:text-yellow-600 dark:text-yellow-300 dark:hover:text-yellow-200"
                >
                  Upgrade your account to add more credits.
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With link on right</h3>
        <div class="rounded-md bg-blue-50 p-4 dark:bg-blue-500/10 dark:outline dark:outline-blue-500/20">
          <div class="flex">
            <div class="shrink-0">
              <Info class="size-5 text-blue-400" />
            </div>
            <div class="ml-3 flex-1 md:flex md:justify-between">
              <p class="text-sm text-blue-700 dark:text-blue-300">
                A new software update is available. See what's new in version 2.0.4.
              </p>
              <p class="mt-3 text-sm md:mt-0 md:ml-6">
                <a
                  href="#"
                  class="font-medium whitespace-nowrap text-blue-700 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  Details
                  <span aria-hidden="true"> &rarr;</span>
                </a>
              </p>
            </div>
            <div class="ml-auto pl-3">
              <div class="-mx-1.5 -my-1.5">
                <button
                  type="button"
                  class="inline-flex rounded-md bg-blue-50 p-1.5 text-blue-500 hover:bg-blue-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-blue-50 focus-visible:outline-hidden dark:bg-transparent dark:text-blue-400 dark:hover:bg-blue-500/10 dark:focus-visible:ring-blue-500 dark:focus-visible:ring-offset-1 dark:focus-visible:ring-offset-blue-900"
                >
                  <span class="sr-only">Dismiss</span>
                  <X class="size-5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
