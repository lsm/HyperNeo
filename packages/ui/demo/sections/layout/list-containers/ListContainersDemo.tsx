export function ListContainersDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Simple with dividers</h3>
        <ul role="list" class="divide-y divide-gray-200 dark:divide-white/10">
          <li class="py-4">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="py-4">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="py-4">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
        </ul>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Card with dividers</h3>
        <div class="overflow-hidden rounded-md bg-white shadow-sm dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-0 dark:outline-white/10">
          <ul role="list" class="divide-y divide-gray-200 dark:divide-white/10">
            <li class="px-6 py-4">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
            <li class="px-6 py-4">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
            <li class="px-6 py-4">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
          </ul>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Card with dividers full width on mobile
        </h3>
        <div class="overflow-hidden bg-white shadow-sm sm:rounded-md dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
          <ul role="list" class="divide-y divide-gray-200 dark:divide-white/10">
            <li class="px-4 py-4 sm:px-6">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
            <li class="px-4 py-4 sm:px-6">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
            <li class="px-4 py-4 sm:px-6">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
          </ul>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Separate cards</h3>
        <ul role="list" class="space-y-3">
          <li class="overflow-hidden rounded-md bg-white px-6 py-4 shadow-sm dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="overflow-hidden rounded-md bg-white px-6 py-4 shadow-sm dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="overflow-hidden rounded-md bg-white px-6 py-4 shadow-sm dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
        </ul>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Separate cards full width on mobile
        </h3>
        <ul role="list" class="space-y-3">
          <li class="overflow-hidden bg-white px-4 py-4 shadow-sm sm:rounded-md sm:px-6 dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="overflow-hidden bg-white px-4 py-4 shadow-sm sm:rounded-md sm:px-6 dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="overflow-hidden bg-white px-4 py-4 shadow-sm sm:rounded-md sm:px-6 dark:bg-gray-800/50 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
        </ul>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Flat card with dividers</h3>
        <div class="overflow-hidden rounded-md border border-gray-300 bg-white dark:border-white/10 dark:bg-gray-900">
          <ul role="list" class="divide-y divide-gray-300 dark:divide-white/10">
            <li class="px-6 py-4">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
            <li class="px-6 py-4">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
            <li class="px-6 py-4">
              <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
            </li>
          </ul>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Simple with dividers full width on mobile
        </h3>
        <ul role="list" class="divide-y divide-gray-200 dark:divide-white/10">
          <li class="px-4 py-4 sm:px-0">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="px-4 py-4 sm:px-0">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
          <li class="px-4 py-4 sm:px-0">
            <div class="h-8 rounded bg-gray-100 dark:bg-gray-700"></div>
          </li>
        </ul>
      </div>
    </div>
  );
}
