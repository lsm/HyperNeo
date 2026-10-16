import type { RefObject } from 'preact';

export function insertOptionInDomOrder<T extends { ref: RefObject<HTMLElement | null> }>(
  prev: T[],
  option: T,
  element: HTMLElement | null
): T[] {
  if (option.ref.current && element) {
    const allOptions = Array.from(element.querySelectorAll<HTMLElement>('[role="option"]'));
    const index = allOptions.indexOf(option.ref.current);
    if (index !== -1) {
      const next = [...prev];
      next.splice(index, 0, option);
      return next;
    }
  }
  return [...prev, option];
}

export function removeOption<T extends { id: string }>(options: T[], id: string): T[] {
  return options.filter((option) => option.id !== id);
}
