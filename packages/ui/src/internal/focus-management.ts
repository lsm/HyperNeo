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

export enum FocusableMode {
  Strict = 0,
  Loose = 1,
}

export function isFocusableElement(
  element: HTMLElement,
  mode: FocusableMode = FocusableMode.Strict
): boolean {
  if (element === document.body) return false;
  if (mode === FocusableMode.Strict) {
    return element.matches(FOCUSABLE_SELECTOR);
  }
  let current: HTMLElement | null = element;
  while (current !== null) {
    if (current.matches(FOCUSABLE_SELECTOR)) return true;
    current = current.parentElement;
  }
  return false;
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).sort((a, b) =>
    Math.sign((a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER))
  );
}

export enum Focus {
  First = 1,
  Previous = 2,
  Next = 4,
  Last = 8,
  WrapAround = 16,
  NoScroll = 32,
}

export function focusElement(element: HTMLElement | null, scroll = true): void {
  if (!element) return;
  if (scroll) {
    element.focus();
  } else {
    element.focus({ preventScroll: true });
  }
}

export function focusIn(container: HTMLElement | HTMLElement[], focus: Focus): boolean {
  const elements = Array.isArray(container)
    ? container.slice().sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      })
    : getFocusableElements(container);

  const active = document.activeElement as HTMLElement | null;
  const direction = (() => {
    if (focus & (Focus.First | Focus.Next)) return 1;
    if (focus & (Focus.Previous | Focus.Last)) return -1;
    throw new Error('Missing Focus direction');
  })();

  const startIndex = (() => {
    if (focus & Focus.First) return 0;
    if (focus & Focus.Previous)
      return Math.max(0, active !== null ? elements.indexOf(active) - 1 : -1);
    if (focus & Focus.Next) return active !== null ? elements.indexOf(active) + 1 : 0;
    if (focus & Focus.Last) return elements.length - 1;
    throw new Error('Missing Focus startIndex');
  })();

  const shouldWrap = focus & Focus.WrapAround;
  const noScroll = focus & Focus.NoScroll;

  for (let i = 0; i < elements.length; i++) {
    const offset = (startIndex + i * direction + elements.length) % elements.length;
    if (!shouldWrap && offset < 0) break;
    if (!shouldWrap && offset >= elements.length) break;

    const el = elements[offset];
    if (!el) continue;

    focusElement(el, !noScroll);
    if (document.activeElement === el) return true;
  }

  return false;
}
