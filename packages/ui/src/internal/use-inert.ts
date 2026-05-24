import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

export function useInert(containerRef: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const parent = container.parentElement;
    if (!parent) return;

    const siblings: HTMLElement[] = [];
    const originalInert: (string | null)[] = [];

    for (const child of Array.from(parent.children)) {
      if (child === container) continue;
      if (child instanceof HTMLElement) {
        siblings.push(child);
        originalInert.push(child.getAttribute('inert'));
        child.setAttribute('inert', '');
      }
    }

    return () => {
      siblings.forEach((sibling, i) => {
        const original = originalInert[i];
        if (original === null) {
          sibling.removeAttribute('inert');
        } else {
          sibling.setAttribute('inert', original);
        }
      });
    };
  }, [enabled, containerRef]);
}
