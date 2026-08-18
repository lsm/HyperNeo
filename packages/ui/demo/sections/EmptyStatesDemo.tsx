import { Folder, Plus, Users } from 'lucide-preact';

export function EmptyStatesDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Basic</h3>
        <div class="text-center">
          <svg
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
            class="mx-auto size-12 text-text-tertiary dark:text-text-secondary"
          >
            <path
              d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <h3 class="mt-2 text-sm font-semibold text-text-primary dark:text-white">No projects</h3>
          <p class="mt-1 text-sm text-text-secondary dark:text-text-secondary">
            Get started by creating a new project.
          </p>
          <div class="mt-6">
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:bg-accent-500 dark:shadow-none dark:hover:bg-accent-400 dark:focus-visible:outline-accent-400"
            >
              <Plus class="mr-1.5 size-5" />
              New Project
            </button>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With description</h3>
        <div class="text-center">
          <Folder class="mx-auto size-12 text-gray-400 dark:text-gray-500" />
          <h3 class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">No projects yet</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Get started by creating a new project to organize your work.
          </p>
          <div class="mt-6">
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
            >
              <Plus class="mr-1.5 size-5" />
              New Project
            </button>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon</h3>
        <div class="text-center">
          <svg
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
            class="mx-auto size-12 text-gray-400 dark:text-gray-500"
          >
            <path
              d="M20 7h-9m9 10h-9M4 7h.01M4 17h.01M4 12h16"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <h3 class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">
            No candidates yet
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Get started by adding a candidate to your pipeline.
          </p>
          <div class="mt-6">
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
            >
              <Plus class="mr-1.5 size-5" />
              Add a candidate
            </button>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With action</h3>
        <div class="text-center">
          <svg
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
            class="mx-auto size-12 text-gray-400 dark:text-gray-500"
          >
            <path
              d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <h3 class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">
            No team members yet
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Invite your team members to collaborate on this project.
          </p>
          <div class="mt-6">
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
            >
              <Users class="mr-1.5 size-5" />
              Invite team members
            </button>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon and description</h3>
        <div class="rounded-lg border-2 border-dashed border-gray-200 p-8 text-center dark:border-white/10">
          <Folder class="mx-auto size-12 text-gray-400 dark:text-gray-500" />
          <h3 class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">No documents yet</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Get started by uploading your first document.
          </p>
          <div class="mt-6">
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
            >
              <Plus class="mr-1.5 size-5" />
              Upload document
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
