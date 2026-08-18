import { useEffect } from 'preact/hooks';

export function useScrollLock(
  enabled = true,
  ownerDocument: Document | null = typeof document !== 'undefined' ? document : null
): void {
  useEffect(() => {
    if (!enabled || !ownerDocument) return;

    const body = ownerDocument.body;
    const originalOverflow = body.style.overflow;
    const originalPaddingRight = body.style.paddingRight;

    const scrollbarWidth = window.innerWidth - ownerDocument.documentElement.clientWidth;

    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    return () => {
      body.style.overflow = originalOverflow;
      body.style.paddingRight = originalPaddingRight;
    };
  }, [enabled, ownerDocument]);
}
