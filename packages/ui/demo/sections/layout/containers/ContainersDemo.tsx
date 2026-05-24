export function ContainersDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Full width on mobile, constrained with padded content above
        </h3>
        <div class="container mx-auto px-4 sm:px-6 lg:px-8">
          <div class="h-24 rounded bg-gray-100 dark:bg-gray-700"></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Constrained with padded content</h3>
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="h-24 rounded bg-gray-100 dark:bg-gray-700"></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Full width on mobile, constrained to breakpoint with padded content above mobile
        </h3>
        <div class="mx-auto max-w-7xl sm:px-6 lg:px-8">
          <div class="h-24 rounded bg-gray-100 dark:bg-gray-700"></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Constrained to breakpoint with padded content
        </h3>
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="mx-auto max-w-3xl">
            <div class="h-24 rounded bg-gray-100 dark:bg-gray-700"></div>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Narrow constrained with padded content
        </h3>
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div class="mx-auto max-w-3xl">
            <div class="h-24 rounded bg-gray-100 dark:bg-gray-700"></div>
          </div>
        </div>
      </div>
    </div>
  );
}
