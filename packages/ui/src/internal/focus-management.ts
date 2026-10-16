export const FOCUSABLE_SELECTOR = [
  '[contentEditable=true]',
  '[tabindex]',
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'iframe',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
]
  .map((selector) => `${selector}:not([tabindex="-1"]):not([disabled])`)
  .join(', ');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).sort((a, b) =>
    Math.sign((a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER))
  );
}

export function focusElement(element: HTMLElement | null, scroll = true): void {
  if (!element) return;
  if (scroll) {
    element.focus();
  } else {
    element.focus({ preventScroll: true });
  }
}
