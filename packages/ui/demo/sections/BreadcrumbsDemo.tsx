import { ChevronRight, Home } from 'lucide-preact';

const pages = [
  { name: 'Projects', href: '#', current: false },
  { name: 'Project Nero', href: '#', current: true },
];

export function ContainedBreadcrumbs() {
  return (
    <nav aria-label="Breadcrumb" class="flex">
      <ol role="list" class="flex items-center space-x-4">
        <li>
          <div>
            <a
              href="#"
              class="text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-text-secondary"
            >
              <Home aria-hidden="true" class="size-5 shrink-0" />
              <span class="sr-only">Home</span>
            </a>
          </div>
        </li>
        {pages.map((page) => (
          <li key={page.name}>
            <div class="flex items-center">
              <ChevronRight
                aria-hidden="true"
                class="size-5 shrink-0 text-text-tertiary dark:text-text-tertiary"
              />
              <a
                href={page.href}
                aria-current={page.current ? 'page' : undefined}
                class="ml-4 text-sm font-medium text-text-secondary hover:text-text-primary dark:text-text-tertiary dark:hover:text-text-secondary"
              >
                {page.name}
              </a>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function FullWidthBarBreadcrumbs() {
  return (
    <nav
      aria-label="Breadcrumb"
      class="flex border-b border-surface-border bg-surface-0 dark:border-white/10 dark:bg-surface-2/50"
    >
      <ol role="list" class="mx-auto flex w-full max-w-screen-xl space-x-4 px-4 sm:px-6 lg:px-8">
        <li class="flex">
          <div class="flex items-center">
            <a
              href="#"
              class="text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-text-secondary"
            >
              <Home aria-hidden="true" class="size-5 shrink-0" />
              <span class="sr-only">Home</span>
            </a>
          </div>
        </li>
        {pages.map((page) => (
          <li key={page.name} class="flex">
            <div class="flex items-center">
              <svg
                fill="currentColor"
                viewBox="0 0 24 44"
                preserveAspectRatio="none"
                aria-hidden="true"
                class="h-full w-6 shrink-0 text-surface-2 dark:text-white/10"
              >
                <path d="M.293 0l22 22-22 22h1.414l22-22-22-22H.293z" />
              </svg>
              <a
                href={page.href}
                aria-current={page.current ? 'page' : undefined}
                class="ml-4 text-sm font-medium text-text-secondary hover:text-text-primary dark:text-text-tertiary dark:hover:text-text-secondary"
              >
                {page.name}
              </a>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function SimpleWithChevronsBreadcrumbs() {
  return (
    <nav aria-label="Breadcrumb" class="flex">
      <ol
        role="list"
        class="flex space-x-4 rounded-md bg-surface-0 px-6 shadow-sm dark:bg-surface-2/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10"
      >
        <li class="flex">
          <div class="flex items-center">
            <a
              href="#"
              class="text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-text-secondary"
            >
              <Home aria-hidden="true" class="size-5 shrink-0" />
              <span class="sr-only">Home</span>
            </a>
          </div>
        </li>
        {pages.map((page) => (
          <li key={page.name} class="flex">
            <div class="flex items-center">
              <svg
                fill="currentColor"
                viewBox="0 0 24 44"
                preserveAspectRatio="none"
                aria-hidden="true"
                class="h-full w-6 shrink-0 text-surface-2 dark:text-white/10"
              >
                <path d="M.293 0l22 22-22 22h1.414l22-22-22-22H.293z" />
              </svg>
              <a
                href={page.href}
                aria-current={page.current ? 'page' : undefined}
                class="ml-4 text-sm font-medium text-text-secondary hover:text-text-primary dark:text-text-tertiary dark:hover:text-text-secondary"
              >
                {page.name}
              </a>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function SimpleWithSlashesBreadcrumbs() {
  return (
    <nav aria-label="Breadcrumb" class="flex">
      <ol role="list" class="flex items-center space-x-4">
        <li>
          <div>
            <a
              href="#"
              class="text-text-tertiary hover:text-text-secondary dark:text-text-tertiary dark:hover:text-text-secondary"
            >
              <Home aria-hidden="true" class="size-5 shrink-0" />
              <span class="sr-only">Home</span>
            </a>
          </div>
        </li>
        {pages.map((page) => (
          <li key={page.name}>
            <div class="flex items-center">
              <svg
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
                class="size-5 shrink-0 text-surface-2 dark:text-text-tertiary"
              >
                <path d="M5.555 17.776l8-16 .894.448-8 16-.894-.448z" />
              </svg>
              <a
                href={page.href}
                aria-current={page.current ? 'page' : undefined}
                class="ml-4 text-sm font-medium text-text-secondary hover:text-text-primary dark:text-text-tertiary dark:hover:text-text-secondary"
              >
                {page.name}
              </a>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function BreadcrumbsDemo() {
  return (
    <div class="flex flex-col gap-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Contained</h3>
        <ContainedBreadcrumbs />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Full width bar</h3>
        <FullWidthBarBreadcrumbs />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple with chevrons</h3>
        <SimpleWithChevronsBreadcrumbs />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple with slashes</h3>
        <SimpleWithSlashesBreadcrumbs />
      </div>
    </div>
  );
}
