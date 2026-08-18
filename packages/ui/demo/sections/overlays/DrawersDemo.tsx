import { useState } from 'preact/hooks';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  TransitionChild,
} from '../../../src/mod.ts';
import {
  Bell,
  EllipsisVertical,
  File,
  Heart,
  Link,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Trash,
  X,
} from 'lucide-preact';

function EmptyDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="flex h-full flex-col overflow-y-auto bg-white py-6 shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="px-4 sm:px-6">
                    <div class="flex items-start justify-between">
                      <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                        Panel title
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="relative mt-6 flex-1 px-4 sm:px-6"></div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function EmptyWideDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open wide drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-2xl transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="flex h-full flex-col overflow-y-auto bg-white py-6 shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="px-4 sm:px-6">
                    <div class="flex items-start justify-between">
                      <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                        Panel title
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="relative mt-6 flex-1 px-4 sm:px-6"></div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function DrawerWithOverlay() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-gray-500/75 transition-opacity duration-500 ease-in-out data-[closed]:opacity-0 dark:bg-gray-900/50"
        />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="flex h-full flex-col overflow-y-auto bg-white py-6 shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="px-4 sm:px-6">
                    <div class="flex items-start justify-between">
                      <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                        Panel title
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="relative mt-6 flex-1 px-4 sm:px-6"></div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function DrawerWithCloseButtonOutside() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-gray-500/75 transition-opacity duration-500 ease-in-out data-[closed]:opacity-0 dark:bg-gray-900/50"
        />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto relative w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <TransitionChild>
                  <div class="absolute top-0 left-0 -ml-8 flex pt-4 pr-2 duration-500 ease-in-out data-[closed]:opacity-0 sm:-ml-10 sm:pr-4">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      class="relative rounded-md text-gray-300 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-gray-400 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                    >
                      <span class="absolute -inset-2.5" />
                      <span class="sr-only">Close panel</span>
                      <X class="size-6" />
                    </button>
                  </div>
                </TransitionChild>
                <div class="relative flex h-full flex-col overflow-y-auto bg-white py-6 shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="px-4 sm:px-6">
                    <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                      Panel title
                    </DialogTitle>
                  </div>
                  <div class="relative mt-6 flex-1 px-4 sm:px-6"></div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function DrawerWithBrandedHeader() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="relative flex h-full flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="bg-indigo-700 px-4 py-6 sm:px-6 dark:bg-indigo-800">
                    <div class="flex items-center justify-between">
                      <DialogTitle class="text-base font-semibold text-white">
                        Panel title
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-indigo-200 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white dark:text-indigo-300 dark:hover:text-white cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                    <div class="mt-1">
                      <p class="text-sm text-indigo-300 dark:text-indigo-200">
                        Lorem, ipsum dolor sit amet consectetur adipisicing elit aliquam ad hic
                        recusandae soluta.
                      </p>
                    </div>
                  </div>
                  <div class="relative flex-1 px-4 py-6 sm:px-6"></div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function DrawerWithStickyFooter() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="relative flex h-full flex-col divide-y divide-gray-200 bg-white shadow-xl dark:divide-white/10 dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto py-6">
                    <div class="px-4 sm:px-6">
                      <div class="flex items-start justify-between">
                        <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                          Panel title
                        </DialogTitle>
                        <div class="ml-3 flex h-7 items-center">
                          <button
                            type="button"
                            onClick={() => setOpen(false)}
                            class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                          >
                            <span class="absolute -inset-2.5" />
                            <span class="sr-only">Close panel</span>
                            <X class="size-6" />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div class="relative mt-6 flex-1 px-4 sm:px-6"></div>
                  </div>
                  <div class="flex shrink-0 justify-end px-4 py-4">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:inset-ring-gray-400 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="ml-4 inline-flex justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500 cursor-pointer"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

const team = [
  {
    name: 'Tom Cook',
    email: 'tom.cook@example.com',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Whitney Francis',
    email: 'whitney.francis@example.com',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1517365830460-955ce3ccd263?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Leonard Krasner',
    email: 'leonard.krasner@example.com',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1519345182560-3f2917c472ef?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Floyd Miles',
    email: 'floyd.miles@example.com',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1463453091185-61582044d556?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Emily Selman',
    email: 'emily.selman@example.com',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1502685104226-ee32379fefbe?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

function CreateProjectFormDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-2xl transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <form class="relative flex h-full flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="flex-1">
                    <div class="bg-gray-50 px-4 py-6 sm:px-6 dark:bg-gray-800/50">
                      <div class="flex items-start justify-between space-x-3">
                        <div class="space-y-1">
                          <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                            New project
                          </DialogTitle>
                          <p class="text-sm text-gray-500 dark:text-gray-400">
                            Get started by filling in the information below to create your new
                            project.
                          </p>
                        </div>
                        <div class="flex h-7 items-center">
                          <button
                            type="button"
                            onClick={() => setOpen(false)}
                            class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                          >
                            <span class="absolute -inset-2.5" />
                            <span class="sr-only">Close panel</span>
                            <X class="size-6" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="space-y-6 py-6 sm:space-y-0 sm:divide-y sm:divide-gray-200 sm:py-0 dark:sm:divide-white/10">
                      <div class="space-y-2 px-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:space-y-0 sm:px-6 sm:py-5">
                        <div>
                          <label
                            for="project-name"
                            class="block text-sm/6 font-medium text-gray-900 sm:mt-1.5 dark:text-white"
                          >
                            Project name
                          </label>
                        </div>
                        <div class="sm:col-span-2">
                          <input
                            id="project-name"
                            name="project-name"
                            type="text"
                            class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                          />
                        </div>
                      </div>

                      <div class="space-y-2 px-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:space-y-0 sm:px-6 sm:py-5">
                        <div>
                          <label
                            for="project-description"
                            class="block text-sm/6 font-medium text-gray-900 sm:mt-1.5 dark:text-white"
                          >
                            Description
                          </label>
                        </div>
                        <div class="sm:col-span-2">
                          <textarea
                            id="project-description"
                            name="project-description"
                            rows={3}
                            class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                          />
                        </div>
                      </div>

                      <div class="space-y-2 px-4 sm:grid sm:grid-cols-3 sm:items-center sm:gap-4 sm:space-y-0 sm:px-6 sm:py-5">
                        <div>
                          <h3 class="text-sm/6 font-medium text-gray-900 dark:text-white">
                            Team Members
                          </h3>
                        </div>
                        <div class="sm:col-span-2">
                          <div class="flex space-x-2">
                            {team.map((person) => (
                              <a
                                key={person.email}
                                href={person.href}
                                class="shrink-0 rounded-full hover:opacity-75"
                              >
                                <img
                                  alt={person.name}
                                  src={person.imageUrl}
                                  class="inline-block size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                                />
                              </a>
                            ))}

                            <button
                              type="button"
                              class="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-white/20 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-white/30 dark:hover:text-gray-200 dark:focus-visible:outline-indigo-500 cursor-pointer"
                            >
                              <span class="absolute -inset-2" />
                              <span class="sr-only">Add team member</span>
                              <Plus class="size-5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      <fieldset class="space-y-2 px-4 sm:grid sm:grid-cols-3 sm:items-start sm:gap-4 sm:space-y-0 sm:px-6 sm:py-5">
                        <legend class="sr-only">Privacy</legend>
                        <div
                          aria-hidden="true"
                          class="text-sm/6 font-medium text-gray-900 dark:text-white"
                        >
                          Privacy
                        </div>
                        <div class="space-y-5 sm:col-span-2">
                          <div class="space-y-5 sm:mt-0">
                            <div class="relative flex items-start">
                              <div class="absolute flex h-6 items-center">
                                <input
                                  value="public"
                                  checked
                                  id="privacy-public"
                                  name="privacy"
                                  type="radio"
                                  aria-describedby="privacy-public-description"
                                  class="relative size-4 appearance-none rounded-full border border-gray-300 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/20 dark:bg-black/10 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/10 dark:disabled:bg-gray-800 dark:disabled:before:bg-white/20 forced-colors:appearance-auto forced-colors:before:hidden"
                                />
                              </div>
                              <div class="pl-7 text-sm/6">
                                <label
                                  for="privacy-public"
                                  class="font-medium text-gray-900 dark:text-white"
                                >
                                  Public access
                                </label>
                                <p
                                  id="privacy-public-description"
                                  class="text-gray-500 dark:text-gray-400"
                                >
                                  Everyone with the link will see this project.
                                </p>
                              </div>
                            </div>
                            <div class="relative flex items-start">
                              <div class="absolute flex h-6 items-center">
                                <input
                                  value="private-to-project"
                                  id="privacy-private-to-project"
                                  name="privacy"
                                  type="radio"
                                  aria-describedby="privacy-private-to-project-description"
                                  class="relative size-4 appearance-none rounded-full border border-gray-300 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/20 dark:bg-black/10 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/10 dark:disabled:bg-gray-800 dark:disabled:before:bg-white/20 forced-colors:appearance-auto forced-colors:before:hidden"
                                />
                              </div>
                              <div class="pl-7 text-sm/6">
                                <label
                                  for="privacy-private-to-project"
                                  class="font-medium text-gray-900 dark:text-white"
                                >
                                  Private to project members
                                </label>
                                <p class="text-gray-500 dark:text-gray-400">
                                  Only members of this project would be able to access.
                                </p>
                              </div>
                            </div>
                            <div class="relative flex items-start">
                              <div class="absolute flex h-6 items-center">
                                <input
                                  value="private"
                                  id="privacy-private"
                                  name="privacy"
                                  type="radio"
                                  class="relative size-4 appearance-none rounded-full border border-gray-300 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/20 dark:bg-black/10 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/10 dark:disabled:bg-gray-800 dark:disabled:before:bg-white/20 forced-colors:appearance-auto forced-colors:before:hidden"
                                />
                              </div>
                              <div class="pl-7 text-sm/6">
                                <label
                                  for="privacy-private"
                                  class="font-medium text-gray-900 dark:text-white"
                                >
                                  Private to you
                                </label>
                                <p class="text-gray-500 dark:text-gray-400">
                                  You are the only one able to access this project.
                                </p>
                              </div>
                            </div>
                          </div>
                          <hr class="border-gray-200 dark:border-white/10" />
                          <div class="flex flex-col items-start space-y-4 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
                            <div>
                              <a
                                href="#"
                                class="group flex items-center space-x-2.5 text-sm font-medium text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300"
                              >
                                <Link
                                  aria-hidden="true"
                                  class="size-5 text-indigo-500 group-hover:text-indigo-900 dark:text-indigo-400 dark:group-hover:text-indigo-300"
                                />
                                <span>Copy link</span>
                              </a>
                            </div>
                            <div>
                              <a
                                href="#"
                                class="group flex items-center space-x-2.5 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-300"
                              >
                                <Bell
                                  aria-hidden="true"
                                  class="size-5 text-gray-400 group-hover:text-gray-500 dark:text-gray-600 dark:group-hover:text-gray-400"
                                />
                                <span>Learn more about sharing</span>
                              </a>
                            </div>
                          </div>
                        </div>
                      </fieldset>
                    </div>
                  </div>

                  <div class="shrink-0 border-t border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
                    <div class="flex justify-end space-x-3">
                      <button
                        type="button"
                        onClick={() => setOpen(false)}
                        class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-gray-100 dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        class="inline-flex justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500 cursor-pointer"
                      >
                        Create
                      </button>
                    </div>
                  </div>
                </form>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function WideCreateProjectFormDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open wide drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <form class="relative flex h-full flex-col divide-y divide-gray-200 bg-white shadow-xl dark:divide-white/10 dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="h-0 flex-1 overflow-y-auto">
                    <div class="bg-indigo-700 px-4 py-6 sm:px-6 dark:bg-indigo-800">
                      <div class="flex items-center justify-between">
                        <DialogTitle class="text-base font-semibold text-white">
                          New project
                        </DialogTitle>
                        <div class="ml-3 flex h-7 items-center">
                          <button
                            type="button"
                            onClick={() => setOpen(false)}
                            class="relative rounded-md text-indigo-200 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white dark:text-indigo-300 dark:hover:text-white cursor-pointer"
                          >
                            <span class="absolute -inset-2.5" />
                            <span class="sr-only">Close panel</span>
                            <X class="size-6" />
                          </button>
                        </div>
                      </div>
                      <div class="mt-1">
                        <p class="text-sm text-indigo-300">
                          Get started by filling in the information below to create your new
                          project.
                        </p>
                      </div>
                    </div>
                    <div class="flex flex-1 flex-col justify-between">
                      <div class="divide-y divide-gray-200 px-4 sm:px-6 dark:divide-white/10">
                        <div class="space-y-6 pt-6 pb-5">
                          <div>
                            <label
                              for="wide-project-name"
                              class="block text-sm/6 font-medium text-gray-900 dark:text-gray-100"
                            >
                              Project name
                            </label>
                            <div class="mt-2">
                              <input
                                id="wide-project-name"
                                name="wide-project-name"
                                type="text"
                                class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                              />
                            </div>
                          </div>
                          <div>
                            <label
                              for="wide-project-description"
                              class="block text-sm/6 font-medium text-gray-900 dark:text-gray-100"
                            >
                              Description
                            </label>
                            <div class="mt-2">
                              <textarea
                                id="wide-project-description"
                                name="wide-project-description"
                                rows={3}
                                class="block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
                              />
                            </div>
                          </div>
                          <div>
                            <h3 class="text-sm/6 font-medium text-gray-900 dark:text-gray-100">
                              Team Members
                            </h3>
                            <div class="mt-2">
                              <div class="flex space-x-2">
                                {team.map((person) => (
                                  <a
                                    key={person.email}
                                    href={person.href}
                                    class="relative rounded-full hover:opacity-75"
                                  >
                                    <img
                                      alt={person.name}
                                      src={person.imageUrl}
                                      class="inline-block size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                                    />
                                  </a>
                                ))}
                                <button
                                  type="button"
                                  class="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-white/20 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-white/30 dark:hover:text-gray-200 dark:focus-visible:outline-indigo-500 cursor-pointer"
                                >
                                  <span class="absolute -inset-2" />
                                  <span class="sr-only">Add team member</span>
                                  <Plus class="size-5" />
                                </button>
                              </div>
                            </div>
                          </div>
                          <fieldset>
                            <legend class="text-sm/6 font-medium text-gray-900 dark:text-gray-100">
                              Privacy
                            </legend>
                            <div class="mt-2 space-y-4">
                              <div class="relative flex items-start">
                                <div class="absolute flex h-6 items-center">
                                  <input
                                    value="public"
                                    checked
                                    id="privacy-public-2"
                                    name="privacy-2"
                                    type="radio"
                                    class="relative size-4 appearance-none rounded-full border border-gray-300 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/20 dark:bg-black/10 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/10 dark:disabled:bg-gray-800 dark:disabled:before:bg-white/20 forced-colors:appearance-auto forced-colors:before:hidden"
                                  />
                                </div>
                                <div class="pl-7 text-sm/6">
                                  <label
                                    for="privacy-public-2"
                                    class="font-medium text-gray-900 dark:text-gray-100"
                                  >
                                    Public access
                                  </label>
                                  <p class="text-gray-500 dark:text-gray-400">
                                    Everyone with the link will see this project.
                                  </p>
                                </div>
                              </div>
                              <div>
                                <div class="relative flex items-start">
                                  <div class="absolute flex h-6 items-center">
                                    <input
                                      value="private-to-project"
                                      id="privacy-private-to-project-2"
                                      name="privacy-2"
                                      type="radio"
                                      class="relative size-4 appearance-none rounded-full border border-gray-300 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/20 dark:bg-black/10 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/10 dark:disabled:bg-gray-800 dark:disabled:before:bg-white/20 forced-colors:appearance-auto forced-colors:before:hidden"
                                    />
                                  </div>
                                  <div class="pl-7 text-sm/6">
                                    <label
                                      for="privacy-private-to-project-2"
                                      class="font-medium text-gray-900 dark:text-gray-100"
                                    >
                                      Private to project members
                                    </label>
                                    <p class="text-gray-500 dark:text-gray-400">
                                      Only members of this project would be able to access.
                                    </p>
                                  </div>
                                </div>
                              </div>
                              <div>
                                <div class="relative flex items-start">
                                  <div class="absolute flex h-6 items-center">
                                    <input
                                      value="private"
                                      id="privacy-private-2"
                                      name="privacy-2"
                                      type="radio"
                                      class="relative size-4 appearance-none rounded-full border border-gray-300 before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/20 dark:bg-black/10 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/10 dark:disabled:bg-gray-800 dark:disabled:before:bg-white/20 forced-colors:appearance-auto forced-colors:before:hidden"
                                    />
                                  </div>
                                  <div class="pl-7 text-sm/6">
                                    <label
                                      for="privacy-private-2"
                                      class="font-medium text-gray-900 dark:text-gray-100"
                                    >
                                      Private to you
                                    </label>
                                    <p class="text-gray-500 dark:text-gray-400">
                                      You are the only one able to access this project.
                                    </p>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </fieldset>
                        </div>
                        <div class="pt-4 pb-6">
                          <div class="flex text-sm">
                            <a
                              href="#"
                              class="group inline-flex items-center font-medium text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300"
                            >
                              <Link
                                aria-hidden="true"
                                class="size-5 text-indigo-500 group-hover:text-indigo-900 dark:text-indigo-400 dark:group-hover:text-indigo-300"
                              />
                              <span class="ml-2">Copy link</span>
                            </a>
                          </div>
                          <div class="mt-4 flex text-sm">
                            <a
                              href="#"
                              class="group inline-flex items-center text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
                            >
                              <Bell
                                aria-hidden="true"
                                class="size-5 text-gray-400 group-hover:text-gray-500 dark:text-gray-600 dark:group-hover:text-gray-300"
                              />
                              <span class="ml-2">Learn more about sharing</span>
                            </a>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="flex shrink-0 justify-end px-4 py-4">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      class="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-gray-100 dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="ml-4 inline-flex justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500 cursor-pointer"
                    >
                      Save
                    </button>
                  </div>
                </form>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function UserProfileDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="relative flex h-full flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="px-4 py-6 sm:px-6">
                    <div class="flex items-start justify-between">
                      <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                        Profile
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div class="pb-1 sm:pb-6">
                      <div>
                        <div class="relative h-40 sm:h-56">
                          <img
                            alt=""
                            src="https://images.unsplash.com/photo-1501031170107-cfd33f0cbdcc?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=crop&w=800&h=600&q=80"
                            class="absolute size-full object-cover"
                          />
                        </div>
                        <div class="mt-6 px-4 sm:mt-8 sm:flex sm:items-end sm:px-6">
                          <div class="sm:flex-1">
                            <div>
                              <div class="flex items-center">
                                <h3 class="text-xl font-bold text-gray-900 sm:text-2xl dark:text-white">
                                  Ashley Porter
                                </h3>
                                <span class="ml-2.5 inline-block size-2 shrink-0 rounded-full bg-green-400">
                                  <span class="sr-only">Online</span>
                                </span>
                              </div>
                              <p class="text-sm text-gray-500 dark:text-gray-400">@ashleyporter</p>
                            </div>
                            <div class="mt-5 flex flex-wrap space-y-3 sm:space-y-0 sm:space-x-3">
                              <button
                                type="button"
                                class="inline-flex w-full shrink-0 items-center justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 sm:flex-1 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500 cursor-pointer"
                              >
                                <MessageCircle class="size-4 mr-2" />
                                Message
                              </button>
                              <button
                                type="button"
                                class="inline-flex w-full flex-1 items-center justify-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-gray-100 dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                              >
                                <Phone class="size-4 mr-2" />
                                Call
                              </button>
                              <div class="ml-3 inline-flex sm:ml-0">
                                <Menu as="div" class="relative inline-block text-left">
                                  <MenuButton class="relative inline-flex items-center rounded-md bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-gray-100 dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer">
                                    <span class="absolute -inset-1" />
                                    <span class="sr-only">Open options menu</span>
                                    <EllipsisVertical class="size-5" />
                                  </MenuButton>
                                  <MenuItems
                                    transition
                                    class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-white shadow-lg outline-1 outline-black/5 transition data-[closed]:scale-95 data-[closed]:transform data-[closed]:opacity-0 data-[enter]:duration-100 data-[enter]:ease-out data-[leave]:duration-75 data-[leave]:ease-in dark:bg-gray-800 dark:-outline-offset-1 dark:outline-white/10"
                                  >
                                    <div class="py-1">
                                      <MenuItem>
                                        <a
                                          href="#"
                                          class="block px-4 py-2 text-sm text-gray-700 data-[focus]:bg-gray-100 data-[focus]:text-gray-900 data-[focus]:outline-hidden dark:text-gray-300 dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                                        >
                                          View profile
                                        </a>
                                      </MenuItem>
                                      <MenuItem>
                                        <a
                                          href="#"
                                          class="block px-4 py-2 text-sm text-gray-700 data-[focus]:bg-gray-100 data-[focus]:text-gray-900 data-[focus]:outline-hidden dark:text-gray-300 dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                                        >
                                          Copy profile link
                                        </a>
                                      </MenuItem>
                                    </div>
                                  </MenuItems>
                                </Menu>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="px-4 pt-5 pb-5 sm:px-0 sm:pt-0">
                      <dl class="space-y-8 px-4 sm:space-y-6 sm:px-6">
                        <div>
                          <dt class="text-sm font-medium text-gray-500 sm:w-40 sm:shrink-0 dark:text-gray-400">
                            Bio
                          </dt>
                          <dd class="mt-1 text-sm text-gray-900 sm:col-span-2 dark:text-white">
                            <p>
                              Enim feugiat ut ipsum, neque ut. Tristique mi id elementum praesent.
                              Gravida in tempus feugiat netus enim aliquet a, quam scelerisque.
                              Dictumst in convallis nec in bibendum aenean arcu.
                            </p>
                          </dd>
                        </div>
                        <div>
                          <dt class="text-sm font-medium text-gray-500 sm:w-40 sm:shrink-0 dark:text-gray-400">
                            Location
                          </dt>
                          <dd class="mt-1 text-sm text-gray-900 sm:col-span-2 dark:text-white">
                            New York, NY, USA
                          </dd>
                        </div>
                        <div>
                          <dt class="text-sm font-medium text-gray-500 sm:w-40 sm:shrink-0 dark:text-gray-400">
                            Website
                          </dt>
                          <dd class="mt-1 text-sm text-gray-900 sm:col-span-2 dark:text-white">
                            ashleyporter.com
                          </dd>
                        </div>
                        <div>
                          <dt class="text-sm font-medium text-gray-500 sm:w-40 sm:shrink-0 dark:text-gray-400">
                            Birthday
                          </dt>
                          <dd class="mt-1 text-sm text-gray-900 sm:col-span-2 dark:text-white">
                            <time dateTime="1988-06-23">June 23, 1988</time>
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function FileDetailsSlideOver() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open wide drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-gray-500/75 transition-opacity duration-500 ease-in-out data-[closed]:opacity-0 dark:bg-gray-900/50"
        />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto relative w-96 transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <TransitionChild>
                  <div class="absolute top-0 left-0 -ml-8 flex pt-4 pr-2 duration-500 ease-in-out data-[closed]:opacity-0 sm:-ml-10 sm:pr-4">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      class="relative rounded-md text-gray-300 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-gray-400 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                    >
                      <span class="absolute -inset-2.5" />
                      <span class="sr-only">Close panel</span>
                      <X class="size-6" />
                    </button>
                  </div>
                </TransitionChild>
                <div class="relative h-full overflow-y-auto bg-white p-8 dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="space-y-6 pb-16">
                    <div>
                      <img
                        alt=""
                        src="https://images.unsplash.com/photo-1582053433976-25c00369fc93?ixid=MXwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHw%3D&ixlib=rb-1.2.1&auto=format&fit=crop&w=512&q=80"
                        class="block aspect-10/7 w-full rounded-lg bg-gray-100 object-cover outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                      />
                      <div class="mt-4 flex items-start justify-between">
                        <div>
                          <h2 class="text-base font-semibold text-gray-900 dark:text-white">
                            <span class="sr-only">Details for </span>IMG_4985.HEIC
                          </h2>
                          <p class="text-sm font-medium text-gray-500 dark:text-gray-400">3.9 MB</p>
                        </div>
                        <button
                          type="button"
                          class="relative ml-4 flex size-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-indigo-600 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-1.5" />
                          <Heart class="size-6" />
                          <span class="sr-only">Favorite</span>
                        </button>
                      </div>
                    </div>
                    <div>
                      <h3 class="font-medium text-gray-900 dark:text-white">Information</h3>
                      <dl class="mt-2 divide-y divide-gray-200 border-t border-b border-gray-200 dark:divide-white/10 dark:border-white/10">
                        <div class="flex justify-between py-3 text-sm font-medium">
                          <dt class="text-gray-500 dark:text-gray-400">Uploaded by</dt>
                          <dd class="text-gray-900 dark:text-white">Marie Culver</dd>
                        </div>
                        <div class="flex justify-between py-3 text-sm font-medium">
                          <dt class="text-gray-500 dark:text-gray-400">Created</dt>
                          <dd class="text-gray-900 dark:text-white">June 8, 2020</dd>
                        </div>
                        <div class="flex justify-between py-3 text-sm font-medium">
                          <dt class="text-gray-500 dark:text-gray-400">Last modified</dt>
                          <dd class="text-gray-900 dark:text-white">June 8, 2020</dd>
                        </div>
                        <div class="flex justify-between py-3 text-sm font-medium">
                          <dt class="text-gray-500 dark:text-gray-400">Dimensions</dt>
                          <dd class="text-gray-900 dark:text-white">4032 x 3024</dd>
                        </div>
                        <div class="flex justify-between py-3 text-sm font-medium">
                          <dt class="text-gray-500 dark:text-gray-400">Resolution</dt>
                          <dd class="text-gray-900 dark:text-white">72 x 72</dd>
                        </div>
                      </dl>
                    </div>
                    <div>
                      <h3 class="font-medium text-gray-900 dark:text-white">Description</h3>
                      <div class="mt-2 flex items-center justify-between">
                        <p class="text-sm text-gray-500 italic dark:text-gray-400">
                          Add a description to this image.
                        </p>
                        <button
                          type="button"
                          class="relative -mr-2 flex size-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-indigo-600 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-1.5" />
                          <Pencil class="size-5" />
                          <span class="sr-only">Add description</span>
                        </button>
                      </div>
                    </div>
                    <div>
                      <h3 class="font-medium text-gray-900 dark:text-white">Shared with</h3>
                      <ul
                        role="list"
                        class="mt-2 divide-y divide-gray-200 border-t border-b border-gray-200 dark:divide-white/10 dark:border-white/10"
                      >
                        <li class="flex items-center justify-between py-3">
                          <div class="flex items-center">
                            <img
                              alt=""
                              src="https://images.unsplash.com/photo-1502685104226-ee32379fefbe?ixlib=rb-=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=3&w=1024&h=1024&q=80"
                              class="size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                            />
                            <p class="ml-4 text-sm font-medium text-gray-900 dark:text-white">
                              Aimee Douglas
                            </p>
                          </div>
                          <button
                            type="button"
                            class="ml-6 rounded-md text-sm font-medium text-indigo-600 hover:text-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300 dark:focus-visible:outline-indigo-500 cursor-pointer"
                          >
                            Remove<span class="sr-only"> Aimee Douglas</span>
                          </button>
                        </li>
                        <li class="flex items-center justify-between py-3">
                          <div class="flex items-center">
                            <img
                              alt=""
                              src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixqx=oilqXxSqey&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                              class="size-8 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                            />
                            <p class="ml-4 text-sm font-medium text-gray-900 dark:text-white">
                              Andrea McMillan
                            </p>
                          </div>
                          <button
                            type="button"
                            class="ml-6 rounded-md text-sm font-medium text-indigo-600 hover:text-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300 dark:focus-visible:outline-indigo-500 cursor-pointer"
                          >
                            Remove<span class="sr-only"> Andrea McMillan</span>
                          </button>
                        </li>
                        <li class="flex items-center justify-between py-2">
                          <button
                            type="button"
                            class="group -ml-1 flex items-center rounded-md p-1 focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-500 cursor-pointer"
                          >
                            <span class="flex size-8 items-center justify-center rounded-full border-2 border-dashed border-gray-300 text-gray-400 dark:border-white/20">
                              <Plus class="size-5" />
                            </span>
                            <span class="ml-4 text-sm font-medium text-indigo-600 group-hover:text-indigo-500 dark:text-indigo-400 dark:group-hover:text-indigo-300">
                              Share
                            </span>
                          </button>
                        </li>
                      </ul>
                    </div>
                    <div class="flex">
                      <button
                        type="button"
                        class="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500 cursor-pointer"
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        class="ml-3 flex-1 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-gray-100 dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

const tabs = [
  { name: 'All', href: '#', current: true },
  { name: 'Online', href: '#', current: false },
  { name: 'Offline', href: '#', current: false },
];
const contacts = [
  {
    name: 'Leslie Alexander',
    handle: 'lesliealexander',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    status: 'online',
  },
  {
    name: 'Michael Foster',
    handle: 'michaelfoster',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    status: 'online',
  },
  {
    name: 'Dries Vincent',
    handle: 'driesvincent',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    status: 'online',
  },
  {
    name: 'Lindsay Walton',
    handle: 'lindsaywalton',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    status: 'offline',
  },
  {
    name: 'Courtney Henry',
    handle: 'courtneyhenry',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    status: 'offline',
  },
  {
    name: 'Tom Cook',
    handle: 'tomcook',
    href: '#',
    imageUrl:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    status: 'offline',
  },
];

function ContactListDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <div class="fixed inset-0" />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="relative flex h-full flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="p-6">
                    <div class="flex items-start justify-between">
                      <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                        Team
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="border-b border-gray-200 dark:border-white/10">
                    <div class="px-6">
                      <nav class="-mb-px flex space-x-6">
                        {tabs.map((tab) => (
                          <a
                            key={tab.name}
                            href={tab.href}
                            class={cn(
                              tab.current
                                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white',
                              'border-b-2 px-1 pb-4 text-sm font-medium whitespace-nowrap'
                            )}
                          >
                            {tab.name}
                          </a>
                        ))}
                      </nav>
                    </div>
                  </div>
                  <ul
                    role="list"
                    class="flex-1 divide-y divide-gray-200 overflow-y-auto dark:divide-white/10"
                  >
                    {contacts.map((person) => (
                      <li key={person.handle}>
                        <div class="group relative flex items-center px-5 py-6">
                          <a href={person.href} class="-m-1 block flex-1 p-1">
                            <div class="absolute inset-0 group-hover:bg-gray-50 dark:group-hover:bg-white/2.5" />
                            <div class="relative flex min-w-0 flex-1 items-center">
                              <span class="relative inline-block shrink-0">
                                <img
                                  alt=""
                                  src={person.imageUrl}
                                  class="size-10 rounded-full bg-gray-100 outline -outline-offset-1 outline-black/5 dark:bg-gray-800 dark:outline-white/10"
                                />
                                <span
                                  aria-hidden="true"
                                  class={cn(
                                    person.status === 'online'
                                      ? 'bg-green-400'
                                      : 'bg-gray-300 dark:bg-gray-500',
                                    'absolute top-0 right-0 block size-2.5 rounded-full ring-2 ring-white dark:ring-gray-800'
                                  )}
                                />
                              </span>
                              <div class="ml-4 truncate">
                                <p class="truncate text-sm font-medium text-gray-900 dark:text-white">
                                  {person.name}
                                </p>
                                <p class="truncate text-sm text-gray-500 dark:text-gray-400">
                                  {'@' + person.handle}
                                </p>
                              </div>
                            </div>
                          </a>
                          <Menu as="div" class="relative ml-2 inline-block shrink-0 text-left">
                            <MenuButton class="group relative inline-flex size-8 items-center justify-center rounded-full bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-gray-800 dark:focus-visible:outline-indigo-500 cursor-pointer">
                              <span class="absolute -inset-1.5" />
                              <span class="sr-only">Open options menu</span>
                              <span class="flex size-full items-center justify-center rounded-full">
                                <EllipsisVertical class="size-5 text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300" />
                              </span>
                            </MenuButton>
                            <MenuItems
                              transition
                              class="absolute top-0 right-full z-10 mr-1 w-48 origin-top-right rounded-md bg-white shadow-lg outline-1 outline-black/5 transition data-[closed]:scale-95 data-[closed]:transform data-[closed]:opacity-0 data-[enter]:duration-100 data-[enter]:ease-out data-[leave]:duration-75 data-[leave]:ease-in dark:bg-gray-800 dark:-outline-offset-1 dark:outline-white/10"
                            >
                              <div class="py-1">
                                <MenuItem>
                                  <a
                                    href="#"
                                    class="block px-4 py-2 text-sm text-gray-700 data-[focus]:bg-gray-100 data-[focus]:text-gray-900 data-[focus]:outline-hidden dark:text-gray-300 dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                                  >
                                    View profile
                                  </a>
                                </MenuItem>
                                <MenuItem>
                                  <a
                                    href="#"
                                    class="block px-4 py-2 text-sm text-gray-700 data-[focus]:bg-gray-100 data-[focus]:text-gray-900 data-[focus]:outline-hidden dark:text-gray-300 dark:data-[focus]:bg-white/5 dark:data-[focus]:text-white"
                                  >
                                    Send message
                                  </a>
                                </MenuItem>
                              </div>
                            </MenuItems>
                          </Menu>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function FileDetailsDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <div class="space-y-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="rounded-md bg-gray-950/5 px-2.5 py-1.5 text-sm font-semibold text-gray-900 hover:bg-gray-950/10 dark:bg-white/10 dark:text-white dark:inset-ring dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
      >
        Open drawer
      </button>

      <Dialog open={open} onClose={setOpen} class="relative z-10">
        <DialogBackdrop
          transition
          class="fixed inset-0 bg-gray-500/75 transition-opacity duration-500 ease-in-out data-[closed]:opacity-0 dark:bg-gray-900/50"
        />

        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10 sm:pl-16">
              <DialogPanel
                transition
                class="pointer-events-auto w-screen max-w-md transform transition duration-500 ease-in-out data-[closed]:translate-x-full sm:duration-700"
              >
                <div class="relative flex h-full flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-800 dark:after:absolute dark:after:inset-y-0 dark:after:left-0 dark:after:w-px dark:after:bg-white/10">
                  <div class="px-4 py-6 sm:px-6">
                    <div class="flex items-start justify-between">
                      <DialogTitle class="text-base font-semibold text-gray-900 dark:text-white">
                        File Details
                      </DialogTitle>
                      <div class="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          onClick={() => setOpen(false)}
                          class="relative rounded-md text-gray-400 hover:text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:hover:text-white dark:focus-visible:outline-indigo-500 cursor-pointer"
                        >
                          <span class="absolute -inset-2.5" />
                          <span class="sr-only">Close panel</span>
                          <X class="size-6" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div class="flex-1 px-4 sm:px-6 space-y-6">
                    <div class="rounded-lg bg-gray-100 border-2 border-dashed border-gray-300 dark:bg-gray-800 dark:border-gray-600 aspect-video flex items-center justify-center">
                      <div class="text-center">
                        <File class="size-12 mx-auto text-gray-400" />
                        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                          design-specs.pdf
                        </p>
                      </div>
                    </div>

                    <div class="space-y-4">
                      <div>
                        <h3 class="text-sm font-medium text-gray-900 dark:text-white">
                          File Information
                        </h3>
                        <dl class="mt-2 divide-y divide-gray-200 border-t border-b border-gray-200 dark:divide-white/10 dark:border-white/10">
                          <div class="flex justify-between py-3 text-sm">
                            <dt class="text-gray-500 dark:text-gray-400">Size</dt>
                            <dd class="text-gray-900 dark:text-white">2.4 MB</dd>
                          </div>
                          <div class="flex justify-between py-3 text-sm">
                            <dt class="text-gray-500 dark:text-gray-400">Type</dt>
                            <dd class="text-gray-900 dark:text-white">PDF Document</dd>
                          </div>
                          <div class="flex justify-between py-3 text-sm">
                            <dt class="text-gray-500 dark:text-gray-400">Modified</dt>
                            <dd class="text-gray-900 dark:text-white">Mar 15, 2024</dd>
                          </div>
                        </dl>
                      </div>

                      <div class="flex gap-3">
                        <button
                          type="button"
                          class="flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 cursor-pointer"
                        >
                          <Link class="size-4" />
                          Share
                        </button>
                        <button
                          type="button"
                          class="flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:inset-ring-white/5 dark:hover:bg-white/20 cursor-pointer"
                        >
                          <Trash class="size-4" />
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </DialogPanel>
            </div>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function DrawersDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Empty drawer</h3>
        <EmptyDrawer />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Empty wide drawer</h3>
        <EmptyWideDrawer />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With background overlay</h3>
        <DrawerWithOverlay />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With close button on outside</h3>
        <DrawerWithCloseButtonOutside />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With branded header</h3>
        <DrawerWithBrandedHeader />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With sticky footer</h3>
        <DrawerWithStickyFooter />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Create project form</h3>
        <CreateProjectFormDrawer />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Wide create project form</h3>
        <WideCreateProjectFormDrawer />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">User profile</h3>
        <UserProfileDrawer />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Wide file details</h3>
        <FileDetailsSlideOver />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Contact list</h3>
        <ContactListDrawer />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">File details</h3>
        <FileDetailsDrawer />
      </div>
    </div>
  );
}

export {
  DrawersDemo,
  EmptyDrawer,
  EmptyWideDrawer,
  DrawerWithOverlay,
  DrawerWithCloseButtonOutside,
  DrawerWithBrandedHeader,
  DrawerWithStickyFooter,
  CreateProjectFormDrawer,
  WideCreateProjectFormDrawer,
  UserProfileDrawer,
  FileDetailsSlideOver,
  ContactListDrawer,
  FileDetailsDrawer,
};
