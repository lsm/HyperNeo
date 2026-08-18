import { useCallback, useRef } from 'preact/hooks';

export function useTextValue(ref: { current: HTMLElement | null }): () => string {
  const cacheRef = useRef<string>('');

  return useCallback(() => {
    const el = ref.current;
    if (!el) return '';

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let text = '';
    let node = walker.nextNode();
    while (node !== null) {
      text += node.textContent;
      node = walker.nextNode();
    }

    const trimmed = text.trim().toLowerCase();
    cacheRef.current = trimmed;
    return trimmed;
  }, [ref]);
}
