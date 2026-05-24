import { Button, DataInteractive } from '../../src/mod.ts';

export function ButtonDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Basic Button</h3>
        <Button class="bg-accent-500 hover:bg-accent-600 data-[hover]:bg-accent-600 data-[active]:scale-95 text-white px-4 py-2 rounded-lg font-medium transition-all cursor-pointer">
          Click me
        </Button>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          State-driven styling (hover / focus / active)
        </h3>
        <Button class="bg-surface-2 border border-surface-border text-text-primary px-4 py-2 rounded-lg font-medium transition-all cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-text-primary data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500 data-[active]:bg-surface-3">
          Hover, focus, or click me
        </Button>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Button as anchor</h3>
        <Button
          as="a"
          href="#button"
          class="inline-block bg-accent-500 data-[hover]:bg-accent-600 text-white px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer no-underline"
        >
          I render as &lt;a&gt;
        </Button>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Disabled button</h3>
        <Button
          disabled
          class="bg-surface-3 text-text-muted px-4 py-2 rounded-lg font-medium cursor-not-allowed opacity-50"
        >
          Disabled
        </Button>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          DataInteractive wrapping an anchor
        </h3>
        <DataInteractive
          as="a"
          href="#button"
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-surface-border text-text-secondary transition-colors no-underline data-[hover]:border-accent-500 data-[hover]:text-text-primary data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
        >
          <span class="text-accent-400">↗</span>
          DataInteractive anchor
        </DataInteractive>
      </div>
    </div>
  );
}
