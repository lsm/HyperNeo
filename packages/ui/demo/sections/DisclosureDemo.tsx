import { Disclosure, DisclosureButton, DisclosurePanel } from '../../src/mod.ts';

const faqs = [
  {
    question: 'What is a headless UI component?',
    answer:
      'A headless UI component provides behavior and accessibility without any built-in styles. You bring your own styling using Tailwind CSS or any other approach.',
  },
  {
    question: 'How does the disclosure component work?',
    answer:
      'The Disclosure component manages open/closed state and keyboard interactions. The DisclosureButton toggles the panel, and DisclosurePanel shows or hides content accordingly.',
  },
  {
    question: 'Can I have multiple disclosures open at once?',
    answer:
      'Yes — each Disclosure manages its own independent state. To create an accordion where only one is open at a time, you would manage the state externally.',
  },
];

export function DisclosureDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          FAQ-style independent disclosures
        </h3>
        <div class="space-y-2 max-w-lg">
          {faqs.map((faq) => (
            <Disclosure
              as="div"
              class="rounded-lg border border-surface-border overflow-hidden"
              key={faq.question}
            >
              <DisclosureButton class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary bg-surface-2 hover:bg-surface-3 transition-colors text-left cursor-pointer">
                <span>{faq.question}</span>
                <svg
                  class="w-4 h-4 text-text-tertiary transition-transform data-[open]:rotate-180 flex-shrink-0 ml-2"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fill-rule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                    clip-rule="evenodd"
                  />
                </svg>
              </DisclosureButton>
              <DisclosurePanel class="px-4 py-3 text-sm text-text-secondary bg-surface-1 border-t border-surface-border">
                {faq.answer}
              </DisclosurePanel>
            </Disclosure>
          ))}
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">Default open disclosure</h3>
        <div class="max-w-lg">
          <Disclosure
            as="div"
            defaultOpen
            class="rounded-lg border border-accent-500/40 overflow-hidden"
          >
            <DisclosureButton class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary bg-surface-2 hover:bg-surface-3 transition-colors text-left cursor-pointer">
              <span>This panel starts open</span>
              <svg
                class="w-4 h-4 text-accent-400 transition-transform data-[open]:rotate-180 flex-shrink-0 ml-2"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fill-rule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clip-rule="evenodd"
                />
              </svg>
            </DisclosureButton>
            <DisclosurePanel class="px-4 py-3 text-sm text-text-secondary bg-surface-1 border-t border-surface-border">
              This disclosure uses <code class="text-accent-400 font-mono">defaultOpen</code> to
              render expanded on first mount. It still toggles independently.
            </DisclosurePanel>
          </Disclosure>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Chevron rotation via data-[open]:
        </h3>
        <p class="text-xs text-text-muted mb-2">
          The chevron icon uses{' '}
          <code class="text-accent-400 font-mono">data-[open]:rotate-180</code> on the SVG — the
          DisclosureButton propagates its open state as a data attribute to child elements.
        </p>
        <div class="max-w-lg">
          <Disclosure as="div" class="rounded-lg border border-surface-border overflow-hidden">
            <DisclosureButton class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary bg-surface-2 hover:bg-surface-3 transition-colors text-left cursor-pointer group">
              <span>Toggle me to see the chevron rotate</span>
              <svg
                class="w-5 h-5 text-text-tertiary transition-transform duration-200 data-[open]:rotate-180 flex-shrink-0"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fill-rule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clip-rule="evenodd"
                />
              </svg>
            </DisclosureButton>
            <DisclosurePanel class="px-4 py-3 text-sm text-text-secondary bg-surface-1 border-t border-surface-border">
              Panel content revealed. The chevron above has rotated 180 degrees.
            </DisclosurePanel>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
