import { Paperclip } from 'lucide-preact';

function LeftAligned() {
  return (
    <div>
      <div class="px-4 sm:px-0">
        <h3 class="text-base/7 font-semibold text-text-primary dark:text-white">
          Applicant Information
        </h3>
        <p class="mt-1 max-w-2xl text-sm/6 text-text-secondary dark:text-text-tertiary">
          Personal details and application.
        </p>
      </div>
      <div class="mt-6 border-t border-surface-border dark:border-white/10">
        <dl class="divide-y divide-surface-border dark:divide-white/10">
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Full name</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Margot Foster
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Application for</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Backend Developer
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Email address</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              margotfoster@example.com
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">
              Salary expectation
            </dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              $120,000
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">About</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
              consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
              nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
              reprehenderit deserunt qui eu.
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Attachments</dt>
            <dd class="mt-2 text-sm text-text-primary sm:col-span-2 sm:mt-0 dark:text-white">
              <ul
                role="list"
                class="divide-y divide-surface-border rounded-md border border-surface-border dark:divide-white/5 dark:border-white/10"
              >
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        resume_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">2.4mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        coverletter_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">4.5mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function TwoColumn() {
  return (
    <div>
      <div class="px-4 sm:px-0">
        <h3 class="text-base/7 font-semibold text-text-primary dark:text-white">
          Applicant Information
        </h3>
        <p class="mt-1 max-w-2xl text-sm/6 text-text-secondary dark:text-text-tertiary">
          Personal details and application.
        </p>
      </div>
      <div class="mt-6">
        <dl class="grid grid-cols-1 sm:grid-cols-2">
          <div class="border-t border-surface-border px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Full name</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:mt-2 dark:text-text-tertiary">
              Margot Foster
            </dd>
          </div>
          <div class="border-t border-surface-border px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Application for</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:mt-2 dark:text-text-tertiary">
              Backend Developer
            </dd>
          </div>
          <div class="border-t border-surface-border px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Email address</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:mt-2 dark:text-text-tertiary">
              margotfoster@example.com
            </dd>
          </div>
          <div class="border-t border-surface-border px-4 py-6 sm:col-span-1 sm:px-0 dark:border-white/10">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">
              Salary expectation
            </dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:mt-2 dark:text-text-tertiary">
              $120,000
            </dd>
          </div>
          <div class="border-t border-surface-border px-4 py-6 sm:col-span-2 sm:px-0 dark:border-white/10">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">About</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:mt-2 dark:text-text-tertiary">
              Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
              consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
              nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
              reprehenderit deserunt qui eu.
            </dd>
          </div>
          <div class="border-t border-surface-border px-4 py-6 sm:col-span-2 sm:px-0 dark:border-white/10">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Attachments</dt>
            <dd class="mt-2 text-sm text-text-primary dark:text-white">
              <ul
                role="list"
                class="divide-y divide-surface-border rounded-md border border-surface-border dark:divide-white/5 dark:border-white/10"
              >
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        resume_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">2.4mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        coverletter_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">4.5mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function LeftAlignedInCard() {
  return (
    <div class="overflow-hidden bg-white shadow-sm sm:rounded-lg dark:bg-surface-2/50 dark:shadow-none dark:inset-ring dark:inset-ring-white/10">
      <div class="px-4 py-6 sm:px-6">
        <h3 class="text-base/7 font-semibold text-text-primary dark:text-white">
          Applicant Information
        </h3>
        <p class="mt-1 max-w-2xl text-sm/6 text-text-secondary dark:text-text-tertiary">
          Personal details and application.
        </p>
      </div>
      <div class="border-t border-surface-border dark:border-white/5">
        <dl class="divide-y divide-surface-border dark:divide-white/5">
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
            <dt class="text-sm font-medium text-text-primary dark:text-text-tertiary">Full name</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Margot Foster
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
            <dt class="text-sm font-medium text-text-primary dark:text-text-tertiary">
              Application for
            </dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Backend Developer
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
            <dt class="text-sm font-medium text-text-primary dark:text-text-tertiary">
              Email address
            </dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              margotfoster@example.com
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
            <dt class="text-sm font-medium text-text-primary dark:text-text-tertiary">
              Salary expectation
            </dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              $120,000
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
            <dt class="text-sm font-medium text-text-primary dark:text-text-tertiary">About</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
              consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
              nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
              reprehenderit deserunt qui eu.
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-text-tertiary">
              Attachments
            </dt>
            <dd class="mt-2 text-sm text-text-primary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <ul
                role="list"
                class="divide-y divide-surface-border rounded-md border border-surface-border dark:divide-white/5 dark:border-white/10"
              >
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-text-tertiary">
                        resume_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">2.4mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-text-tertiary">
                        coverletter_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">4.5mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function LeftAlignedStriped() {
  return (
    <div>
      <div class="px-4 sm:px-0">
        <h3 class="text-base/7 font-semibold text-text-primary dark:text-white">
          Applicant Information
        </h3>
        <p class="mt-1 max-w-2xl text-sm/6 text-text-secondary dark:text-text-tertiary">
          Personal details and application.
        </p>
      </div>
      <div class="mt-6 border-t border-surface-border dark:border-white/5">
        <dl class="divide-y divide-surface-border dark:divide-white/5">
          <div class="bg-surface-0 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-surface-2/25">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Full name</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Margot Foster
            </dd>
          </div>
          <div class="bg-surface-0 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-surface-2">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Application for</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Backend Developer
            </dd>
          </div>
          <div class="bg-surface-0 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-surface-2/25">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Email address</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              margotfoster@example.com
            </dd>
          </div>
          <div class="bg-surface-0 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-surface-2">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">
              Salary expectation
            </dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              $120,000
            </dd>
          </div>
          <div class="bg-surface-0 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-surface-2/25">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">About</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
              consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
              nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
              reprehenderit deserunt qui eu.
            </dd>
          </div>
          <div class="bg-surface-0 px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-3 dark:bg-surface-2">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Attachments</dt>
            <dd class="mt-2 text-sm text-text-primary sm:col-span-2 sm:mt-0 dark:text-white">
              <ul
                role="list"
                class="divide-y divide-surface-border rounded-md border border-surface-border dark:divide-white/5 dark:border-white/10"
              >
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        resume_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">2.4mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        coverletter_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">4.5mb</span>
                    </div>
                  </div>
                  <div class="ml-4 shrink-0">
                    <a
                      href="#"
                      class="font-medium text-accent-500 hover:text-accent-400 dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Download
                    </a>
                  </div>
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function NarrowWithHiddenLabels() {
  return (
    <div>
      <div class="px-4 sm:px-0">
        <h3 class="text-base/7 font-semibold text-text-primary dark:text-white">
          Applicant Information
        </h3>
        <p class="mt-1 max-w-2xl text-sm/6 text-text-secondary dark:text-text-tertiary">
          Personal details and application.
        </p>
      </div>
      <div class="mt-6 border-t border-surface-border dark:border-white/10">
        <dl class="divide-y divide-surface-border dark:divide-white/10">
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Full name</dt>
            <dd class="mt-1 flex text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <span class="grow">Margot Foster</span>
              <span class="ml-4 shrink-0">
                <button
                  type="button"
                  class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                >
                  Update
                </button>
              </span>
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Application for</dt>
            <dd class="mt-1 flex text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <span class="grow">Backend Developer</span>
              <span class="ml-4 shrink-0">
                <button
                  type="button"
                  class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                >
                  Update
                </button>
              </span>
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Email address</dt>
            <dd class="mt-1 flex text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <span class="grow">margotfoster@example.com</span>
              <span class="ml-4 shrink-0">
                <button
                  type="button"
                  class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                >
                  Update
                </button>
              </span>
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">
              Salary expectation
            </dt>
            <dd class="mt-1 flex text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <span class="grow">$120,000</span>
              <span class="ml-4 shrink-0">
                <button
                  type="button"
                  class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                >
                  Update
                </button>
              </span>
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">About</dt>
            <dd class="mt-1 flex text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <span class="grow">
                Fugiat ipsum ipsum deserunt culpa aute sint do nostrud anim incididunt cillum culpa
                consequat. Excepteur qui ipsum aliquip consequat sint. Sit id mollit nulla mollit
                nostrud in ea officia proident. Irure nostrud pariatur mollit ad adipisicing
                reprehenderit deserunt qui eu.
              </span>
              <span class="ml-4 shrink-0">
                <button
                  type="button"
                  class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                >
                  Update
                </button>
              </span>
            </dd>
          </div>
          <div class="px-4 py-6 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
            <dt class="text-sm/6 font-medium text-text-primary dark:text-white">Attachments</dt>
            <dd class="mt-1 text-sm/6 text-text-secondary sm:col-span-2 sm:mt-0 dark:text-text-tertiary">
              <ul
                role="list"
                class="divide-y divide-surface-border rounded-md border border-surface-border dark:divide-white/5 dark:border-white/10"
              >
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        resume_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">2.4mb</span>
                    </div>
                  </div>
                  <div class="ml-4 flex shrink-0 space-x-4">
                    <button
                      type="button"
                      class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Update
                    </button>
                    <span aria-hidden="true" class="text-text-tertiary dark:text-text-tertiary">
                      |
                    </span>
                    <button
                      type="button"
                      class="rounded-md bg-surface-0 font-medium text-text-primary hover:text-text-secondary dark:bg-transparent dark:text-text-tertiary dark:hover:text-white"
                    >
                      Remove
                    </button>
                  </div>
                </li>
                <li class="flex items-center justify-between py-4 pr-5 pl-4 text-sm/6">
                  <div class="flex w-0 flex-1 items-center">
                    <Paperclip
                      aria-hidden="true"
                      class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
                    />
                    <div class="ml-4 flex min-w-0 flex-1 gap-2">
                      <span class="truncate font-medium text-text-primary dark:text-white">
                        coverletter_back_end_developer.pdf
                      </span>
                      <span class="shrink-0 text-text-tertiary dark:text-text-tertiary">4.5mb</span>
                    </div>
                  </div>
                  <div class="ml-4 flex shrink-0 space-x-4">
                    <button
                      type="button"
                      class="rounded-md bg-surface-0 font-medium text-accent-500 hover:text-accent-400 dark:bg-transparent dark:text-accent-400 dark:hover:text-accent-300"
                    >
                      Update
                    </button>
                    <span aria-hidden="true" class="text-text-tertiary dark:text-text-tertiary">
                      |
                    </span>
                    <button
                      type="button"
                      class="rounded-md bg-surface-0 font-medium text-text-primary hover:text-text-secondary dark:bg-transparent dark:text-text-tertiary dark:hover:text-white"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export function DescriptionListsDemo() {
  return (
    <div class="space-y-12">
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">Left Aligned</h3>
        <LeftAligned />
      </section>
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">Two Column</h3>
        <TwoColumn />
      </section>
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Left Aligned in Card
        </h3>
        <LeftAlignedInCard />
      </section>
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Left Aligned Striped
        </h3>
        <LeftAlignedStriped />
      </section>
      <section>
        <h3 class="text-base font-semibold text-text-primary dark:text-white mb-4">
          Narrow with Hidden Labels
        </h3>
        <NarrowWithHiddenLabels />
      </section>
    </div>
  );
}
