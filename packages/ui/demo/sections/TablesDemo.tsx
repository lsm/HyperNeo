import { Fragment } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { classNames } from '../../src/internal/class-names.ts';

const people1 = [
  {
    name: 'Lindsay Walton',
    title: 'Front-end Developer',
    email: 'lindsay.walton@example.com',
    role: 'Member',
  },
  { name: 'Courtney Henry', title: 'Designer', email: 'courtney.henry@example.com', role: 'Admin' },
  { name: 'Tom Cook', title: 'Director of Product', email: 'tom.cook@example.com', role: 'Member' },
  {
    name: 'Whitney Francis',
    title: 'Copywriter',
    email: 'whitney.francis@example.com',
    role: 'Admin',
  },
  {
    name: 'Leonard Krasner',
    title: 'Senior Designer',
    email: 'leonard.krasner@example.com',
    role: 'Owner',
  },
  {
    name: 'Floyd Miles',
    title: 'Principal Designer',
    email: 'floyd.miles@example.com',
    role: 'Member',
  },
];

export function SimpleTable() {
  return (
    <div>
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div class="sm:flex sm:items-center">
          <div class="sm:flex-auto">
            <h3 class="text-base font-semibold text-text-primary">Users</h3>
            <p class="mt-2 text-sm text-text-secondary">
              A list of all the users in your account including their name, title, email and role.
            </p>
          </div>
          <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
            <button
              type="button"
              class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              Add user
            </button>
          </div>
        </div>
      </div>
      <div class="mt-8 flow-root overflow-hidden">
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <table class="w-full text-left">
            <thead class="bg-surface-0 dark:bg-surface-2">
              <tr>
                <th
                  scope="col"
                  class="relative isolate py-3.5 pr-3 text-left text-sm font-semibold text-text-primary"
                >
                  Name
                  <div class="absolute inset-y-0 right-full -z-10 w-screen border-b border-surface-border" />
                  <div class="absolute inset-y-0 left-0 -z-10 w-screen border-b border-surface-border" />
                </th>
                <th
                  scope="col"
                  class="hidden px-3 py-3.5 text-left text-sm font-semibold text-text-primary sm:table-cell"
                >
                  Title
                </th>
                <th
                  scope="col"
                  class="hidden px-3 py-3.5 text-left text-sm font-semibold text-text-primary md:table-cell"
                >
                  Email
                </th>
                <th
                  scope="col"
                  class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                >
                  Role
                </th>
                <th scope="col" class="py-3.5 pl-3">
                  <span class="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people1.map((person) => (
                <tr key={person.email}>
                  <td class="relative py-4 pr-3 text-sm font-medium text-text-primary">
                    {person.name}
                    <div class="absolute right-full bottom-0 h-px w-screen bg-surface-1" />
                    <div class="absolute bottom-0 left-0 h-px w-screen bg-surface-1" />
                  </td>
                  <td class="hidden px-3 py-4 text-sm text-text-secondary sm:table-cell">
                    {person.title}
                  </td>
                  <td class="hidden px-3 py-4 text-sm text-text-secondary md:table-cell">
                    {person.email}
                  </td>
                  <td class="px-3 py-4 text-sm text-text-secondary">{person.role}</td>
                  <td class="py-4 pl-3 text-right text-sm font-medium">
                    <a href="#" class="text-accent-500 hover:text-accent-400">
                      Edit<span class="sr-only">, {person.name}</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function SimpleInCard() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Role
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-0">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border">
                {people1.map((person) => (
                  <tr key={person.email}>
                    <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-0">
                      {person.name}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.title}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.email}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FullWidthTable() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-3"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Role
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-3">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="bg-surface-0 dark:bg-surface-2">
                {people1.map((person) => (
                  <tr key={person.email} class="even:bg-surface-0">
                    <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-3">
                      {person.name}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.title}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.email}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-3">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const peopleWithAvatars = [
  {
    name: 'Lindsay Walton',
    title: 'Front-end Developer',
    department: 'Optimization',
    email: 'lindsay.walton@example.com',
    role: 'Member',
    image:
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Courtney Henry',
    title: 'Designer',
    department: 'Intranet',
    email: 'courtney.henry@example.com',
    role: 'Admin',
    image:
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Tom Cook',
    title: 'Director of Product',
    department: 'Directives',
    email: 'tom.cook@example.com',
    role: 'Member',
    image:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Whitney Francis',
    title: 'Copywriter',
    department: 'Program',
    email: 'whitney.francis@example.com',
    role: 'Admin',
    image:
      'https://images.unsplash.com/photo-1517365830460-955ce3ccd263?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Leonard Krasner',
    title: 'Senior Designer',
    department: 'Mobility',
    email: 'leonard.krasner@example.com',
    role: 'Owner',
    image:
      'https://images.unsplash.com/photo-1519345182560-3f2917c472ef?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    name: 'Floyd Miles',
    title: 'Principal Designer',
    department: 'Security',
    email: 'floyd.miles@example.com',
    role: 'Member',
    image:
      'https://images.unsplash.com/photo-1463453091185-61582044d556?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

export function FullWidthConstrained() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Role
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-0">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {peopleWithAvatars.map((person) => (
                  <tr key={person.email}>
                    <td class="py-5 pr-3 pl-4 text-sm whitespace-nowrap sm:pl-0">
                      <div class="flex items-center">
                        <div class="size-11 shrink-0">
                          <img alt="" src={person.image} class="size-11 rounded-full" />
                        </div>
                        <div class="ml-4">
                          <div class="font-medium text-text-primary">{person.name}</div>
                          <div class="mt-1 text-text-secondary">{person.email}</div>
                        </div>
                      </div>
                    </td>
                    <td class="px-3 py-5 text-sm whitespace-nowrap text-text-secondary">
                      <div class="text-text-primary">{person.title}</div>
                      <div class="mt-1 text-text-secondary">{person.department}</div>
                    </td>
                    <td class="px-3 py-5 text-sm whitespace-nowrap text-text-secondary">
                      <span class="inline-flex items-center rounded-md bg-green-500/10 px-2 py-1 text-xs font-medium text-green-500 ring-1 ring-green-500/20">
                        Active
                      </span>
                    </td>
                    <td class="px-3 py-5 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-5 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StripedRows() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="-mx-4 mt-8 sm:-mx-0">
        <table class="min-w-full divide-y divide-surface-border">
          <thead>
            <tr>
              <th
                scope="col"
                class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
              >
                Name
              </th>
              <th
                scope="col"
                class="hidden px-3 py-3.5 text-left text-sm font-semibold text-text-primary lg:table-cell"
              >
                Title
              </th>
              <th
                scope="col"
                class="hidden px-3 py-3.5 text-left text-sm font-semibold text-text-primary sm:table-cell"
              >
                Email
              </th>
              <th scope="col" class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary">
                Role
              </th>
              <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-0">
                <span class="sr-only">Edit</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
            {people1.map((person) => (
              <tr key={person.email}>
                <td class="w-full max-w-0 py-4 pr-3 pl-4 text-sm font-medium text-text-primary sm:w-auto sm:max-w-none sm:pl-0">
                  {person.name}
                  <dl class="font-normal lg:hidden">
                    <dt class="sr-only">Title</dt>
                    <dd class="mt-1 truncate text-text-secondary">{person.title}</dd>
                    <dt class="sr-only sm:hidden">Email</dt>
                    <dd class="mt-1 truncate text-text-tertiary sm:hidden">{person.email}</dd>
                  </dl>
                </td>
                <td class="hidden px-3 py-4 text-sm text-text-secondary lg:table-cell">
                  {person.title}
                </td>
                <td class="hidden px-3 py-4 text-sm text-text-secondary sm:table-cell">
                  {person.email}
                </td>
                <td class="px-3 py-4 text-sm text-text-secondary">{person.role}</td>
                <td class="py-4 pr-4 pl-3 text-right text-sm font-medium sm:pr-0">
                  <a href="#" class="text-accent-500 hover:text-accent-400">
                    Edit<span class="sr-only">, {person.name}</span>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UppercaseHeadings() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3 pr-3 pl-4 text-left text-xs font-medium tracking-wide text-text-tertiary uppercase sm:pl-0"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3 text-left text-xs font-medium tracking-wide text-text-tertiary uppercase"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3 text-left text-xs font-medium tracking-wide text-text-tertiary uppercase"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3 text-left text-xs font-medium tracking-wide text-text-tertiary uppercase"
                  >
                    Role
                  </th>
                  <th scope="col" class="py-3 pr-4 pl-3 sm:pr-0">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {people1.map((person) => (
                  <tr key={person.email}>
                    <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-0">
                      {person.name}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.title}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.email}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StackedColumnsMobile() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="-mx-4 mt-8 sm:-mx-0">
        <table class="min-w-full divide-y divide-surface-border">
          <thead>
            <tr>
              <th
                scope="col"
                class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
              >
                Name
              </th>
              <th
                scope="col"
                class="hidden px-3 py-3.5 text-left text-sm font-semibold text-text-primary sm:table-cell"
              >
                Title
              </th>
              <th
                scope="col"
                class="hidden px-3 py-3.5 text-left text-sm font-semibold text-text-primary lg:table-cell"
              >
                Email
              </th>
              <th scope="col" class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary">
                Role
              </th>
              <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-0">
                <span class="sr-only">Edit</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
            {people1.map((person) => (
              <tr key={person.email}>
                <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-0">
                  {person.name}
                </td>
                <td class="hidden px-3 py-4 text-sm whitespace-nowrap text-text-secondary sm:table-cell">
                  {person.title}
                </td>
                <td class="hidden px-3 py-4 text-sm whitespace-nowrap text-text-secondary lg:table-cell">
                  {person.email}
                </td>
                <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                  {person.role}
                </td>
                <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                  <a href="#" class="text-accent-500 hover:text-accent-400">
                    Edit<span class="sr-only">, {person.name}</span>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function HiddenColumnsMobile() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <div class="overflow-hidden shadow-sm outline-1 outline-black/5 sm:rounded-lg">
              <table class="relative min-w-full divide-y divide-surface-border">
                <thead class="bg-surface-0">
                  <tr>
                    <th
                      scope="col"
                      class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-6"
                    >
                      Name
                    </th>
                    <th
                      scope="col"
                      class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                    >
                      Title
                    </th>
                    <th
                      scope="col"
                      class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                    >
                      Email
                    </th>
                    <th
                      scope="col"
                      class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                    >
                      Role
                    </th>
                    <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-6">
                      <span class="sr-only">Edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                  {people1.map((person) => (
                    <tr key={person.email}>
                      <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-6">
                        {person.name}
                      </td>
                      <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                        {person.title}
                      </td>
                      <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                        {person.email}
                      </td>
                      <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                        {person.role}
                      </td>
                      <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-6">
                        <a href="#" class="text-accent-500 hover:text-accent-400">
                          Edit<span class="sr-only">, {person.name}</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AvatarsMultiline() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Role
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-0">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {peopleWithAvatars.map((person) => (
                  <tr key={person.email}>
                    <td class="py-5 pr-3 pl-4 text-sm whitespace-nowrap sm:pl-0">
                      <div class="flex items-center">
                        <div class="size-11 shrink-0">
                          <img
                            alt=""
                            src={person.image}
                            class="size-11 rounded-full dark:outline dark:outline-white/10"
                          />
                        </div>
                        <div class="ml-4">
                          <div class="font-medium text-text-primary">{person.name}</div>
                          <div class="mt-1 text-text-secondary">{person.email}</div>
                        </div>
                      </div>
                    </td>
                    <td class="px-3 py-5 text-sm whitespace-nowrap text-text-secondary">
                      <div class="text-text-primary">{person.title}</div>
                      <div class="mt-1 text-text-secondary">{person.department}</div>
                    </td>
                    <td class="px-3 py-5 text-sm whitespace-nowrap text-text-secondary">
                      <span class="inline-flex items-center rounded-md bg-green-500/10 px-2 py-1 text-xs font-medium text-green-400 ring-1 ring-green-500/20 ring-inset">
                        Active
                      </span>
                    </td>
                    <td class="px-3 py-5 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-5 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const projects = [
  {
    id: 1,
    name: 'Logo redesign',
    description: 'New logo and digital asset playbook.',
    hours: '20.0',
    rate: '$100.00',
    price: '$2,000.00',
  },
  {
    id: 2,
    name: 'Website redesign',
    description: 'Design and program new company website.',
    hours: '52.0',
    rate: '$100.00',
    price: '$5,200.00',
  },
  {
    id: 3,
    name: 'Business cards',
    description: 'Design and production of 3.5" x 2.0" business cards.',
    hours: '12.0',
    rate: '$100.00',
    price: '$1,200.00',
  },
  {
    id: 4,
    name: 'T-shirt design',
    description: 'Three t-shirt design concepts.',
    hours: '4.0',
    rate: '$100.00',
    price: '$400.00',
  },
];

export function StickyHeader() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Invoice</h3>
          <p class="mt-2 text-sm text-text-secondary">
            For work completed from <time dateTime="2022-08-01">August 1, 2022</time> to{' '}
            <time dateTime="2022-08-31">August 31, 2022</time>.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Print
          </button>
        </div>
      </div>
      <div class="-mx-4 mt-8 flow-root sm:mx-0">
        <table class="min-w-full">
          <colgroup>
            <col class="w-full sm:w-1/2" />
            <col class="sm:w-1/6" />
            <col class="sm:w-1/6" />
            <col class="sm:w-1/6" />
          </colgroup>
          <thead class="border-b border-surface-border text-text-primary">
            <tr>
              <th
                scope="col"
                class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
              >
                Project
              </th>
              <th
                scope="col"
                class="hidden px-3 py-3.5 text-right text-sm font-semibold text-text-primary sm:table-cell"
              >
                Hours
              </th>
              <th
                scope="col"
                class="hidden px-3 py-3.5 text-right text-sm font-semibold text-text-primary sm:table-cell"
              >
                Rate
              </th>
              <th
                scope="col"
                class="py-3.5 pr-4 pl-3 text-right text-sm font-semibold text-text-primary sm:pr-0"
              >
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} class="border-b border-surface-border">
                <td class="max-w-0 py-5 pr-3 pl-4 text-sm sm:pl-0">
                  <div class="font-medium text-text-primary">{project.name}</div>
                  <div class="mt-1 truncate text-text-secondary">{project.description}</div>
                </td>
                <td class="hidden px-3 py-5 text-right text-sm text-text-secondary sm:table-cell">
                  {project.hours}
                </td>
                <td class="hidden px-3 py-5 text-right text-sm text-text-secondary sm:table-cell">
                  {project.rate}
                </td>
                <td class="py-5 pr-4 pl-3 text-right text-sm text-text-secondary sm:pr-0">
                  {project.price}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th
                scope="row"
                colSpan={3}
                class="hidden pt-6 pr-3 pl-4 text-right text-sm font-normal text-text-secondary sm:table-cell sm:pl-0"
              >
                Subtotal
              </th>
              <th
                scope="row"
                class="pt-6 pr-3 pl-4 text-left text-sm font-normal text-text-secondary sm:hidden"
              >
                Subtotal
              </th>
              <td class="pt-6 pr-4 pl-3 text-right text-sm text-text-secondary sm:pr-0">
                $8,800.00
              </td>
            </tr>
            <tr>
              <th
                scope="row"
                colSpan={3}
                class="hidden pt-4 pr-3 pl-4 text-right text-sm font-normal text-text-secondary sm:table-cell sm:pl-0"
              >
                Tax
              </th>
              <th
                scope="row"
                class="pt-4 pr-3 pl-4 text-left text-sm font-normal text-text-secondary sm:hidden"
              >
                Tax
              </th>
              <td class="pt-4 pr-4 pl-3 text-right text-sm text-text-secondary sm:pr-0">
                $1,760.00
              </td>
            </tr>
            <tr>
              <th
                scope="row"
                colSpan={3}
                class="hidden pt-4 pr-3 pl-4 text-right text-sm font-semibold text-text-primary sm:table-cell sm:pl-0"
              >
                Total
              </th>
              <th
                scope="row"
                class="pt-4 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:hidden"
              >
                Total
              </th>
              <td class="pt-4 pr-4 pl-3 text-right text-sm font-semibold text-text-primary sm:pr-0">
                $10,560.00
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const people11 = [
  {
    name: 'Lindsay Walton',
    title: 'Front-end Developer',
    email: 'lindsay.walton@example.com',
    role: 'Member',
  },
  { name: 'Courtney Henry', title: 'Designer', email: 'courtney.henry@example.com', role: 'Admin' },
  { name: 'Tom Cook', title: 'Director of Product', email: 'tom.cook@example.com', role: 'Member' },
  {
    name: 'Whitney Francis',
    title: 'Copywriter',
    email: 'whitney.francis@example.com',
    role: 'Admin',
  },
  {
    name: 'Leonard Krasner',
    title: 'Senior Designer',
    email: 'leonard.krasner@example.com',
    role: 'Owner',
  },
  {
    name: 'Floyd Miles',
    title: 'Principal Designer',
    email: 'floyd.miles@example.com',
    role: 'Member',
  },
  {
    name: 'Emily Selman',
    title: 'VP, User Experience',
    email: 'emily.selman@example.com',
    role: 'Member',
  },
  {
    name: 'Kristin Watson',
    title: 'VP, Human Resources',
    email: 'kristin.watson@example.com',
    role: 'Admin',
  },
  {
    name: 'Emma Dorsey',
    title: 'Senior Developer',
    email: 'emma.dorsey@example.com',
    role: 'Member',
  },
  {
    name: 'Alicia Bell',
    title: 'Junior Copywriter',
    email: 'alicia.bell@example.com',
    role: 'Admin',
  },
  {
    name: 'Jenny Wilson',
    title: 'Studio Artist',
    email: 'jenny.wilson@example.com',
    role: 'Owner',
  },
  {
    name: 'Anna Roberts',
    title: 'Partner, Creative',
    email: 'anna.roberts@example.com',
    role: 'Member',
  },
  {
    name: 'Benjamin Russel',
    title: 'Director, Print Operations',
    email: 'benjamin.russel@example.com',
    role: 'Member',
  },
  {
    name: 'Jeffrey Webb',
    title: 'Senior Art Director',
    email: 'jeffrey.webb@example.com',
    role: 'Admin',
  },
  {
    name: 'Kathryn Murphy',
    title: 'Associate Creative Director',
    email: 'kathryn.murphy@example.com',
    role: 'Member',
  },
];

export function VerticalLines() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle">
            <table class="min-w-full border-separate border-spacing-0">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="sticky top-0 z-10 border-b border-surface-border bg-white/75 py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary backdrop-blur-sm backdrop-filter sm:pl-6 lg:pl-8"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="sticky top-0 z-10 hidden border-b border-surface-border bg-white/75 px-3 py-3.5 text-left text-sm font-semibold text-text-primary backdrop-blur-sm backdrop-filter sm:table-cell"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="sticky top-0 z-10 hidden border-b border-surface-border bg-white/75 px-3 py-3.5 text-left text-sm font-semibold text-text-primary backdrop-blur-sm backdrop-filter lg:table-cell"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    class="sticky top-0 z-10 border-b border-surface-border bg-white/75 px-3 py-3.5 text-left text-sm font-semibold text-text-primary backdrop-blur-sm backdrop-filter"
                  >
                    Role
                  </th>
                  <th
                    scope="col"
                    class="sticky top-0 z-10 border-b border-surface-border bg-white/75 py-3.5 pr-4 pl-3 backdrop-blur-sm backdrop-filter sm:pr-6 lg:pr-8"
                  >
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {people11.map((person, personIdx) => (
                  <tr key={person.email}>
                    <td
                      class={classNames(
                        personIdx !== people11.length - 1 ? 'border-b border-surface-border' : '',
                        'py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-6 lg:pl-8'
                      )}
                    >
                      {person.name}
                    </td>
                    <td
                      class={classNames(
                        personIdx !== people11.length - 1 ? 'border-b border-surface-border' : '',
                        'hidden px-3 py-4 text-sm whitespace-nowrap text-text-secondary sm:table-cell'
                      )}
                    >
                      {person.title}
                    </td>
                    <td
                      class={classNames(
                        personIdx !== people11.length - 1 ? 'border-b border-surface-border' : '',
                        'hidden px-3 py-4 text-sm whitespace-nowrap text-text-secondary lg:table-cell'
                      )}
                    >
                      {person.email}
                    </td>
                    <td
                      class={classNames(
                        personIdx !== people11.length - 1 ? 'border-b border-surface-border' : '',
                        'px-3 py-4 text-sm whitespace-nowrap text-text-secondary'
                      )}
                    >
                      {person.role}
                    </td>
                    <td
                      class={classNames(
                        personIdx !== people11.length - 1 ? 'border-b border-surface-border' : '',
                        'py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-8 lg:pr-8'
                      )}
                    >
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const activityItems = [
  {
    user: {
      name: 'Michael Foster',
      imageUrl:
        'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: '2d89f0c8',
    branch: 'main',
    status: 'Completed',
    duration: '25s',
    date: '45 minutes ago',
    dateTime: '2023-01-23T11:00',
  },
  {
    user: {
      name: 'Lindsay Walton',
      imageUrl:
        'https://images.unsplash.com/photo-1517841905240-472988babdf9?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: '249df660',
    branch: 'main',
    status: 'Completed',
    duration: '1m 32s',
    date: '3 hours ago',
    dateTime: '2023-01-23T09:00',
  },
  {
    user: {
      name: 'Courtney Henry',
      imageUrl:
        'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: '11464223',
    branch: 'main',
    status: 'Error',
    duration: '1m 4s',
    date: '12 hours ago',
    dateTime: '2023-01-23T00:00',
  },
  {
    user: {
      name: 'Courtney Henry',
      imageUrl:
        'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: 'dad28e95',
    branch: 'main',
    status: 'Completed',
    duration: '2m 15s',
    date: '2 days ago',
    dateTime: '2023-01-21T13:00',
  },
  {
    user: {
      name: 'Michael Foster',
      imageUrl:
        'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: '624bc94c',
    branch: 'main',
    status: 'Completed',
    duration: '1m 12s',
    date: '5 days ago',
    dateTime: '2023-01-18T12:34',
  },
  {
    user: {
      name: 'Courtney Henry',
      imageUrl:
        'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: 'e111f80e',
    branch: 'main',
    status: 'Completed',
    duration: '1m 56s',
    date: '1 week ago',
    dateTime: '2023-01-16T15:54',
  },
  {
    user: {
      name: 'Michael Foster',
      imageUrl:
        'https://images.unsplash.com/photo-1519244703995-f4e0f30006d5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: '5e136005',
    branch: 'main',
    status: 'Completed',
    duration: '3m 45s',
    date: '1 week ago',
    dateTime: '2023-01-16T11:31',
  },
  {
    user: {
      name: 'Whitney Francis',
      imageUrl:
        'https://images.unsplash.com/photo-1517365830460-955ce3ccd263?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    },
    commit: '5c1fd07f',
    branch: 'main',
    status: 'Completed',
    duration: '37s',
    date: '2 weeks ago',
    dateTime: '2023-01-09T08:45',
  },
];

export function CondensedContent() {
  return (
    <div class="bg-surface-0 py-10 dark:bg-surface-2">
      <h3 class="px-4 text-base/7 font-semibold text-text-primary sm:px-6 lg:px-8">
        Latest activity
      </h3>
      <table class="mt-6 w-full text-left whitespace-nowrap">
        <colgroup>
          <col class="w-full sm:w-4/12" />
          <col class="lg:w-4/12" />
          <col class="lg:w-2/12" />
          <col class="lg:w-1/12" />
          <col class="lg:w-1/12" />
        </colgroup>
        <thead class="border-b border-surface-border text-sm/6 text-text-primary">
          <tr>
            <th scope="col" class="py-2 pr-8 pl-4 font-semibold sm:pl-6 lg:pl-8">
              User
            </th>
            <th scope="col" class="hidden py-2 pr-8 pl-0 font-semibold sm:table-cell">
              Commit
            </th>
            <th
              scope="col"
              class="py-2 pr-4 pl-0 text-right font-semibold sm:pr-8 sm:text-left lg:pr-20"
            >
              Status
            </th>
            <th scope="col" class="hidden py-2 pr-8 pl-0 font-semibold md:table-cell lg:pr-20">
              Duration
            </th>
            <th
              scope="col"
              class="hidden py-2 pr-4 pl-0 text-right font-semibold sm:table-cell sm:pr-6 lg:pr-8"
            >
              Deployed at
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-surface-border">
          {activityItems.map((item) => (
            <tr key={item.commit}>
              <td class="py-4 pr-8 pl-4 sm:pl-6 lg:pl-8">
                <div class="flex items-center gap-x-4">
                  <img alt="" src={item.user.imageUrl} class="size-8 rounded-full bg-surface-1" />
                  <div class="truncate text-sm/6 font-medium text-text-primary">
                    {item.user.name}
                  </div>
                </div>
              </td>
              <td class="hidden py-4 pr-4 pl-0 sm:table-cell sm:pr-8">
                <div class="flex gap-x-3">
                  <div class="font-mono text-sm/6 text-text-secondary">{item.commit}</div>
                  <div class="rounded-md bg-surface-1 px-2 py-1 text-xs font-medium text-text-secondary outline-1 outline-surface-border">
                    {item.branch}
                  </div>
                </div>
              </td>
              <td class="py-4 pr-4 pl-0 text-sm/6 sm:pr-8 lg:pr-20">
                <div class="flex items-center justify-end gap-x-2 sm:justify-start">
                  <time dateTime={item.dateTime} class="text-text-secondary sm:hidden">
                    {item.date}
                  </time>
                  {item.status === 'Completed' ? (
                    <div class="flex-none rounded-full bg-green-500/10 p-1 text-green-500">
                      <div class="size-1.5 rounded-full bg-current" />
                    </div>
                  ) : null}
                  {item.status === 'Error' ? (
                    <div class="flex-none rounded-full bg-red-500/10 p-1 text-red-500">
                      <div class="size-1.5 rounded-full bg-current" />
                    </div>
                  ) : null}
                  <div class="hidden text-text-primary sm:block">{item.status}</div>
                </div>
              </td>
              <td class="hidden py-4 pr-8 pl-0 text-sm/6 text-text-secondary md:table-cell lg:pr-20">
                {item.duration}
              </td>
              <td class="hidden py-4 pr-4 pl-0 text-right text-sm/6 text-text-secondary sm:table-cell sm:pr-6 lg:pr-8">
                <time dateTime={item.dateTime}>{item.date}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ChevronDownIcon = () => (
  <svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path
      fill-rule="evenodd"
      d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
      clip-rule="evenodd"
    />
  </svg>
);

export function SortableHeadings() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
                  >
                    <a href="#" class="group inline-flex">
                      Name
                      <span class="invisible ml-2 flex-none rounded-sm text-text-tertiary group-hover:visible group-focus:visible">
                        <ChevronDownIcon />
                      </span>
                    </a>
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    <a href="#" class="group inline-flex">
                      Title
                      <span class="ml-2 flex-none rounded-sm bg-surface-1 text-text-primary group-hover:bg-surface-2">
                        <ChevronDownIcon />
                      </span>
                    </a>
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    <a href="#" class="group inline-flex">
                      Email
                      <span class="invisible ml-2 flex-none rounded-sm text-text-tertiary group-hover:visible group-focus:visible">
                        <ChevronDownIcon />
                      </span>
                    </a>
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    <a href="#" class="group inline-flex">
                      Role
                      <span class="invisible ml-2 flex-none rounded-sm text-text-tertiary group-hover:visible group-focus:visible">
                        <ChevronDownIcon />
                      </span>
                    </a>
                  </th>
                  <th scope="col" class="py-3.5 pr-0 pl-3">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {people1.map((person) => (
                  <tr key={person.email}>
                    <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-0">
                      {person.name}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.title}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.email}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-4 pr-4 pl-3 text-right text-sm whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const locations = [
  {
    name: 'Edinburgh',
    people: [
      {
        name: 'Lindsay Walton',
        title: 'Front-end Developer',
        email: 'lindsay.walton@example.com',
        role: 'Member',
      },
      {
        name: 'Courtney Henry',
        title: 'Designer',
        email: 'courtney.henry@example.com',
        role: 'Admin',
      },
    ],
  },
  {
    name: 'London',
    people: [
      {
        name: 'Tom Cook',
        title: 'Director of Product',
        email: 'tom.cook@example.com',
        role: 'Member',
      },
      {
        name: 'Whitney Francis',
        title: 'Copywriter',
        email: 'whitney.francis@example.com',
        role: 'Admin',
      },
      {
        name: 'Leonard Krasner',
        title: 'Senior Designer',
        email: 'leonard.krasner@example.com',
        role: 'Owner',
      },
      {
        name: 'Floyd Miles',
        title: 'Principal Designer',
        email: 'floyd.miles@example.com',
        role: 'Member',
      },
    ],
  },
  {
    name: 'Leeds',
    people: [
      {
        name: 'Emily Selman',
        title: 'VP, User Experience',
        email: 'emily.selman@example.com',
        role: 'Member',
      },
      {
        name: 'Kristin Watson',
        title: 'VP, Human Resources',
        email: 'kristin.watson@example.com',
        role: 'Admin',
      },
      {
        name: 'Emma Dorsey',
        title: 'Senior Developer',
        email: 'emma.dorsey@example.com',
        role: 'Member',
      },
    ],
  },
];

export function GroupedRows() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full">
              <thead class="bg-surface-0 dark:bg-surface-2">
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-3"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Role
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-3">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="bg-surface-0 dark:bg-surface-2">
                {locations.map((location) => (
                  <Fragment key={location.name}>
                    <tr class="border-t border-surface-border">
                      <th
                        scope="colgroup"
                        colSpan={5}
                        class="bg-surface-0 py-2 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-3"
                      >
                        {location.name}
                      </th>
                    </tr>
                    {location.people.map((person) => (
                      <tr
                        key={person.email}
                        class={classNames('border-surface-border', 'border-t')}
                      >
                        <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-3">
                          {person.name}
                        </td>
                        <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                          {person.title}
                        </td>
                        <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                          {person.email}
                        </td>
                        <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                          {person.role}
                        </td>
                        <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-3">
                          <a href="#" class="text-accent-500 hover:text-accent-400">
                            Edit<span class="sr-only">, {person.name}</span>
                          </a>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const days = [
  {
    date: 'Today',
    dateTime: '2023-03-22',
    transactions: [
      {
        id: 1,
        invoiceNumber: '00012',
        href: '#',
        amount: '$7,600.00 USD',
        tax: '$500.00',
        status: 'Paid',
        client: 'Reform',
        description: 'Website redesign',
      },
      {
        id: 2,
        invoiceNumber: '00011',
        href: '#',
        amount: '$10,000.00 USD',
        status: 'Withdraw',
        client: 'Tom Cook',
        description: 'Salary',
      },
      {
        id: 3,
        invoiceNumber: '00009',
        href: '#',
        amount: '$2,000.00 USD',
        tax: '$130.00',
        status: 'Overdue',
        client: 'Tuple',
        description: 'Logo design',
      },
    ],
  },
  {
    date: 'Yesterday',
    dateTime: '2023-03-21',
    transactions: [
      {
        id: 4,
        invoiceNumber: '00010',
        href: '#',
        amount: '$14,000.00 USD',
        tax: '$900.00',
        status: 'Paid',
        client: 'SavvyCal',
        description: 'Website redesign',
      },
    ],
  },
];

const ArrowUpCircleIcon = () => (
  <svg
    class="hidden h-6 w-5 flex-none text-text-tertiary sm:block"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <circle cx="10" cy="10" r="10" />
    <path
      fill-rule="evenodd"
      d="M8.75 9a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 .75-.75Zm3.5 1.5a.75.75 0 0 1-1.5 0V9.707l-1.146 1.147a.75.75 0 0 1-1.06-1.06l2.5-2.5a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1-1.06 1.06L13.707 9H14Z"
      clip-rule="evenodd"
    />
  </svg>
);

const ArrowDownCircleIcon = () => (
  <svg
    class="hidden h-6 w-5 flex-none text-text-tertiary sm:block"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <circle cx="10" cy="10" r="10" />
    <path
      fill-rule="evenodd"
      d="M8.75 11a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75ZM10 8.25a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 10 8.25Z"
      clip-rule="evenodd"
    />
  </svg>
);

const ArrowPathIcon = () => (
  <svg
    class="hidden h-6 w-5 flex-none text-text-tertiary sm:block"
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <path
      fill-rule="evenodd"
      d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z"
      clip-rule="evenodd"
    />
  </svg>
);

export function SummaryRows() {
  return (
    <div>
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <h3 class="mx-auto max-w-2xl text-base font-semibold text-text-primary lg:mx-0 lg:max-w-none">
          Recent activity
        </h3>
      </div>
      <div class="mt-6 overflow-hidden border-t border-surface-border">
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="mx-auto max-w-2xl lg:mx-0 lg:max-w-none">
            <table class="w-full text-left">
              <thead class="sr-only">
                <tr>
                  <th>Amount</th>
                  <th class="hidden sm:table-cell">Client</th>
                  <th>More details</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <Fragment key={day.dateTime}>
                    <tr class="text-sm/6 text-text-primary">
                      <th scope="colgroup" colSpan={3} class="relative isolate py-2 font-semibold">
                        <time dateTime={day.dateTime}>{day.date}</time>
                        <div class="absolute inset-y-0 right-full -z-10 w-screen border-b border-surface-border bg-surface-0" />
                        <div class="absolute inset-y-0 left-0 -z-10 w-screen border-b border-surface-border bg-surface-0" />
                      </th>
                    </tr>
                    {day.transactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <td class="relative py-5 pr-6">
                          <div class="flex gap-x-6">
                            {transaction.status === 'Paid' ? (
                              <ArrowUpCircleIcon />
                            ) : transaction.status === 'Withdraw' ? (
                              <ArrowDownCircleIcon />
                            ) : (
                              <ArrowPathIcon />
                            )}
                            <div class="flex-auto">
                              <div class="flex items-start gap-x-3">
                                <div class="text-sm/6 font-medium text-text-primary">
                                  {transaction.amount}
                                </div>
                                {transaction.status === 'Paid' ? (
                                  <div class="rounded-md bg-green-500/10 px-2 py-1 text-xs font-medium text-green-500 ring-1 ring-green-500/20">
                                    {transaction.status}
                                  </div>
                                ) : null}
                                {transaction.status === 'Withdraw' ? (
                                  <div class="rounded-md bg-surface-1 px-2 py-1 text-xs font-medium text-text-secondary ring-1 ring-surface-border">
                                    {transaction.status}
                                  </div>
                                ) : null}
                                {transaction.status === 'Overdue' ? (
                                  <div class="rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500 ring-1 ring-red-500/20">
                                    {transaction.status}
                                  </div>
                                ) : null}
                              </div>
                              {transaction.tax ? (
                                <div class="mt-1 text-xs/5 text-text-secondary">
                                  {transaction.tax} tax
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <div class="absolute right-full bottom-0 h-px w-screen bg-surface-1" />
                          <div class="absolute bottom-0 left-0 h-px w-screen bg-surface-1" />
                        </td>
                        <td class="hidden py-5 pr-6 sm:table-cell">
                          <div class="text-sm/6 text-text-primary">{transaction.client}</div>
                          <div class="mt-1 text-xs/5 text-text-secondary">
                            {transaction.description}
                          </div>
                        </td>
                        <td class="py-5 text-right">
                          <div class="flex justify-end">
                            <a
                              href={transaction.href}
                              class="text-sm/6 font-medium text-accent-500 hover:text-accent-400"
                            >
                              View<span class="hidden sm:inline"> transaction</span>
                              <span class="sr-only">
                                , invoice #{transaction.invoiceNumber}, {transaction.client}
                              </span>
                            </a>
                          </div>
                          <div class="mt-1 text-xs/5 text-text-secondary">
                            Invoice{' '}
                            <span class="text-text-primary">#{transaction.invoiceNumber}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const people17 = [
  {
    name: 'Lindsay Walton',
    title: 'Front-end Developer',
    email: 'lindsay.walton@example.com',
    role: 'Member',
  },
  { name: 'Courtney Henry', title: 'Designer', email: 'courtney.henry@example.com', role: 'Admin' },
  { name: 'Tom Cook', title: 'Director of Product', email: 'tom.cook@example.com', role: 'Member' },
  {
    name: 'Whitney Francis',
    title: 'Copywriter',
    email: 'whitney.francis@example.com',
    role: 'Admin',
  },
  {
    name: 'Leonard Krasner',
    title: 'Senior Designer',
    email: 'leonard.krasner@example.com',
    role: 'Owner',
  },
  {
    name: 'Floyd Miles',
    title: 'Principal Designer',
    email: 'floyd.miles@example.com',
    role: 'Member',
  },
];

export function WithCheckboxes() {
  const checkbox = useRef<HTMLInputElement | null>(null);
  const [checked, setChecked] = useState(false);
  const [indeterminate, setIndeterminate] = useState(false);
  const [selectedPeople, setSelectedPeople] = useState<typeof people17>([]);

  useLayoutEffect(() => {
    const isIndeterminate = selectedPeople.length > 0 && selectedPeople.length < people17.length;
    setChecked(selectedPeople.length === people17.length);
    setIndeterminate(isIndeterminate);
    if (checkbox.current) {
      checkbox.current.indeterminate = isIndeterminate;
    }
  }, [selectedPeople]);

  function toggleAll() {
    setSelectedPeople(checked || indeterminate ? [] : [...people17]);
    setChecked(!checked && !indeterminate);
    setIndeterminate(false);
  }

  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-1.5 text-center text-sm/6 font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <div class="group/table relative">
              <div class="absolute top-0 left-14 z-10 hidden h-12 items-center space-x-3 bg-surface-0 group-has-checked/table:flex sm:left-12 dark:bg-surface-2">
                <button
                  type="button"
                  class="inline-flex items-center rounded-sm bg-white px-2 py-1 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-0 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-white dark:bg-white/10 dark:text-white dark:ring-white/10 dark:hover:bg-white/15 dark:disabled:hover:bg-white/10"
                >
                  Bulk edit
                </button>
                <button
                  type="button"
                  class="inline-flex items-center rounded-sm bg-white px-2 py-1 text-sm font-semibold text-text-primary shadow-xs ring-1 ring-inset ring-surface-border hover:bg-surface-0 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-white dark:bg-white/10 dark:text-white dark:ring-white/10 dark:hover:bg-white/15 dark:disabled:hover:bg-white/10"
                >
                  Delete all
                </button>
              </div>
              <table class="relative min-w-full table-fixed divide-y divide-surface-border">
                <thead>
                  <tr>
                    <th scope="col" class="relative px-7 sm:w-12 sm:px-6">
                      <div class="group absolute top-1/2 left-4 -mt-2 grid size-4 grid-cols-1">
                        <input
                          type="checkbox"
                          class="col-start-1 row-start-1 appearance-none rounded-sm border border-surface-border bg-white checked:border-accent-500 checked:bg-accent-500 indeterminate:border-accent-500 indeterminate:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:border-surface-border disabled:bg-surface-1 disabled:checked:bg-surface-1 dark:border-white/20 dark:bg-surface-2/50 dark:checked:border-accent-500 dark:checked:bg-accent-500 dark:indeterminate:border-accent-500 dark:indeterminate:bg-accent-500 dark:focus-visible:outline-accent-500 dark:disabled:border-white/10 dark:disabled:bg-surface-2 dark:disabled:checked:bg-surface-2 forced-colors:appearance-auto"
                          ref={checkbox}
                          checked={checked}
                          onChange={toggleAll}
                        />
                        <svg
                          class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-text-muted/25 dark:group-has-disabled:stroke-white/25"
                          viewBox="0 0 14 14"
                          fill="none"
                        >
                          <path
                            class="opacity-0 group-has-checked:opacity-100"
                            d="M3 8L6 11L11 3.5"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                          <path
                            class="opacity-0 group-has-indeterminate:opacity-100"
                            d="M3 7H11"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </div>
                    </th>
                    <th
                      scope="col"
                      class="min-w-48 py-3.5 pr-3 text-left text-sm font-semibold text-text-primary"
                    >
                      Name
                    </th>
                    <th
                      scope="col"
                      class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                    >
                      Title
                    </th>
                    <th
                      scope="col"
                      class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                    >
                      Email
                    </th>
                    <th
                      scope="col"
                      class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                    >
                      Role
                    </th>
                    <th scope="col" class="py-3.5 pr-4 pl-3 sm:pr-3">
                      <span class="sr-only">Edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                  {people17.map((person) => (
                    <tr
                      key={person.email}
                      class="group has-checked:bg-surface-0 dark:has-checked:bg-surface-2/50"
                    >
                      <td class="relative px-7 sm:w-12 sm:px-6">
                        <div class="absolute inset-y-0 left-0 hidden w-0.5 bg-accent-500 group-has-checked:block" />

                        <div class="absolute top-1/2 left-4 -mt-2 grid size-4 grid-cols-1">
                          <input
                            type="checkbox"
                            class="col-start-1 row-start-1 appearance-none rounded-sm border border-surface-border bg-white checked:border-accent-500 checked:bg-accent-500 indeterminate:border-accent-500 indeterminate:bg-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:border-surface-border disabled:bg-surface-1 disabled:checked:bg-surface-1 dark:border-white/20 dark:bg-surface-2/50 dark:checked:border-accent-500 dark:checked:bg-accent-500 dark:indeterminate:border-accent-500 dark:indeterminate:bg-accent-500 dark:focus-visible:outline-accent-500 dark:disabled:border-white/10 dark:disabled:bg-surface-2 dark:disabled:checked:bg-surface-2 forced-colors:appearance-auto"
                            value={person.email}
                            checked={selectedPeople.includes(person)}
                            onChange={(e) =>
                              setSelectedPeople(
                                (e.target as HTMLInputElement).checked
                                  ? [...selectedPeople, person]
                                  : selectedPeople.filter((p) => p !== person)
                              )
                            }
                          />
                          <svg
                            class="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white group-has-disabled:stroke-text-muted/25 dark:group-has-disabled:stroke-white/25"
                            viewBox="0 0 14 14"
                            fill="none"
                          >
                            <path
                              class="opacity-0 group-has-checked:opacity-100"
                              d="M3 8L6 11L11 3.5"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                            <path
                              class="opacity-0 group-has-indeterminate:opacity-100"
                              d="M3 7H11"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                        </div>
                      </td>
                      <td class="py-4 pr-3 text-sm font-medium whitespace-nowrap text-text-primary group-has-checked:text-accent-500 dark:group-has-checked:text-accent-400">
                        {person.name}
                      </td>
                      <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                        {person.title}
                      </td>
                      <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                        {person.email}
                      </td>
                      <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                        {person.role}
                      </td>
                      <td class="py-4 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-3">
                        <a href="#" class="text-accent-500 hover:text-accent-400">
                          Edit<span class="sr-only">, {person.name}</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const transactions = [
  {
    id: 'AAPS0L',
    company: 'Chase & Co.',
    share: 'CAC',
    commission: '+$4.37',
    price: '$3,509.00',
    quantity: '12.00',
    netAmount: '$4,397.00',
  },
  {
    id: 'O2KMND',
    company: 'Amazon.com Inc.',
    share: 'AMZN',
    commission: '+$5.92',
    price: '$2,900.00',
    quantity: '8.80',
    netAmount: '$3,509.00',
  },
  {
    id: '1LP2P4',
    company: 'Procter & Gamble',
    share: 'PG',
    commission: '-$5.65',
    price: '$7,978.00',
    quantity: '2.30',
    netAmount: '$2,652.00',
  },
  {
    id: 'PS9FJGL',
    company: 'Berkshire Hathaway',
    share: 'BRK',
    commission: '+$4.37',
    price: '$3,116.00',
    quantity: '48.00',
    netAmount: '$6,055.00',
  },
  {
    id: 'QYR135',
    company: 'Apple Inc.',
    share: 'AAPL',
    commission: '+$38.00',
    price: '$8,508.00',
    quantity: '36.00',
    netAmount: '$3,496.00',
  },
  {
    id: '99SLSM',
    company: 'NVIDIA Corporation',
    share: 'NVDA',
    commission: '+$1,427.00',
    price: '$4,425.00',
    quantity: '18.00',
    netAmount: '$2,109.00',
  },
  {
    id: 'OSDJLS',
    company: 'Johnson & Johnson',
    share: 'JNJ',
    commission: '+$1,937.23',
    price: '$4,038.00',
    quantity: '32.00',
    netAmount: '$7,210.00',
  },
  {
    id: '4HJK3N',
    company: 'JPMorgan',
    share: 'JPM',
    commission: '-$3.67',
    price: '$3,966.00',
    quantity: '80.00',
    netAmount: '$6,432.00',
  },
];

export function HiddenHeadings() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Transactions</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A table of placeholder stock market data that does not make any sense.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Export
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold whitespace-nowrap text-text-primary sm:pl-0"
                  >
                    Transaction ID
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Company
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Share
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Commission
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Price
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Quantity
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Net amount
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 whitespace-nowrap sm:pr-0">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td class="py-2 pr-3 pl-4 text-sm whitespace-nowrap text-text-secondary sm:pl-0">
                      {transaction.id}
                    </td>
                    <td class="px-2 py-2 text-sm font-medium whitespace-nowrap text-text-primary">
                      {transaction.company}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-primary">
                      {transaction.share}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.commission}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.price}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.quantity}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.netAmount}
                    </td>
                    <td class="py-2 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {transaction.id}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FullWidthAvatars() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="min-w-full divide-y divide-surface-border">
              <thead>
                <tr class="divide-x divide-surface-border">
                  <th
                    scope="col"
                    class="py-3.5 pr-4 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Title
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    class="py-3.5 pr-4 pl-4 text-left text-sm font-semibold text-text-primary sm:pr-0"
                  >
                    Role
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {people1.map((person) => (
                  <tr key={person.email} class="divide-x divide-surface-border">
                    <td class="py-4 pr-4 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-0">
                      {person.name}
                    </td>
                    <td class="p-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.title}
                    </td>
                    <td class="p-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.email}
                    </td>
                    <td class="py-4 pr-4 pl-4 text-sm whitespace-nowrap text-text-secondary sm:pr-0">
                      {person.role}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TablesDemo() {
  return (
    <div class="space-y-12">
      <SimpleTable />
      <SimpleInCard />
      <FullWidthTable />
      <FullWidthConstrained />
      <StripedRows />
      <UppercaseHeadings />
      <StackedColumnsMobile />
      <HiddenColumnsMobile />
      <AvatarsMultiline />
      <StickyHeader />
      <VerticalLines />
      <CondensedContent />
      <SortableHeadings />
      <GroupedRows />
      <SummaryRows />
      <WithCheckboxes />
      <HiddenHeadings />
      <FullWidthAvatars />
      <SortableHeadingsIcon />
      <HiddenHeadingsIcon />
    </div>
  );
}

function ChevronDownIconLocal({ class: className }: { class?: string }) {
  return (
    <svg class={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

export function SortableHeadingsIcon() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Users</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A list of all the users in your account including their name, title, email and role.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Add user
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-text-primary sm:pl-0"
                  >
                    <a href="#" class="group inline-flex">
                      Name
                      <span class="invisible ml-2 flex-none rounded-sm text-text-tertiary group-hover:visible group-focus:visible">
                        <ChevronDownIconLocal class="size-5" />
                      </span>
                    </a>
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    <a href="#" class="group inline-flex">
                      Title
                      <span class="ml-2 flex-none rounded-sm bg-surface-1 text-text-primary group-hover:bg-surface-2">
                        <ChevronDownIconLocal class="size-5" />
                      </span>
                    </a>
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    <a href="#" class="group inline-flex">
                      Email
                      <span class="invisible ml-2 flex-none rounded-sm text-text-tertiary group-hover:visible group-focus:visible">
                        <ChevronDownIconLocal class="size-5" />
                      </span>
                    </a>
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-text-primary"
                  >
                    <a href="#" class="group inline-flex">
                      Role
                      <span class="invisible ml-2 flex-none rounded-sm text-text-tertiary group-hover:visible group-focus:visible">
                        <ChevronDownIconLocal class="size-5" />
                      </span>
                    </a>
                  </th>
                  <th scope="col" class="py-3.5 pr-0 pl-3">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {people1.map((person) => (
                  <tr key={person.email}>
                    <td class="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-text-primary sm:pl-0">
                      {person.name}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.title}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.email}
                    </td>
                    <td class="px-3 py-4 text-sm whitespace-nowrap text-text-secondary">
                      {person.role}
                    </td>
                    <td class="py-4 pr-4 pl-3 text-right text-sm whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {person.name}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HiddenHeadingsIcon() {
  return (
    <div class="px-4 sm:px-6 lg:px-8">
      <div class="sm:flex sm:items-center">
        <div class="sm:flex-auto">
          <h3 class="text-base font-semibold text-text-primary">Transactions</h3>
          <p class="mt-2 text-sm text-text-secondary">
            A table of placeholder stock market data that does not make any sense.
          </p>
        </div>
        <div class="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <button
            type="button"
            class="block rounded-md bg-accent-500 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Export
          </button>
        </div>
      </div>
      <div class="mt-8 flow-root">
        <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table class="relative min-w-full divide-y divide-surface-border">
              <thead>
                <tr>
                  <th
                    scope="col"
                    class="py-3.5 pr-3 pl-4 text-left text-sm font-semibold whitespace-nowrap text-text-primary sm:pl-0"
                  >
                    Transaction ID
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Company
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Share
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Commission
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Price
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Quantity
                  </th>
                  <th
                    scope="col"
                    class="px-2 py-3.5 text-left text-sm font-semibold whitespace-nowrap text-text-primary"
                  >
                    Net amount
                  </th>
                  <th scope="col" class="py-3.5 pr-4 pl-3 whitespace-nowrap sm:pr-0">
                    <span class="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-border bg-surface-0 dark:bg-surface-2">
                {transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td class="py-2 pr-3 pl-4 text-sm whitespace-nowrap text-text-secondary sm:pl-0">
                      {transaction.id}
                    </td>
                    <td class="px-2 py-2 text-sm font-medium whitespace-nowrap text-text-primary">
                      {transaction.company}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-primary">
                      {transaction.share}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.commission}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.price}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.quantity}
                    </td>
                    <td class="px-2 py-2 text-sm whitespace-nowrap text-text-secondary">
                      {transaction.netAmount}
                    </td>
                    <td class="py-2 pr-4 pl-3 text-right text-sm font-medium whitespace-nowrap sm:pr-0">
                      <a href="#" class="text-accent-500 hover:text-accent-400">
                        Edit<span class="sr-only">, {transaction.id}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
