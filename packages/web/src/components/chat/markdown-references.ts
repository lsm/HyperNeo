import { t } from '../../lib/i18n/index.ts';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mark(element: Element, reference: string) {
  element.setAttribute('data-preview-reference', reference);
  if (element.tagName === 'A') return;
  element.setAttribute('role', 'link');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-label', t('artifact.openNamed', { name: reference }));
}

export function markPreviewReferences(container: HTMLElement, references: readonly string[]) {
  if (references.length === 0) return;
  const wanted = new Set(references);
  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    if (wanted.has(href)) mark(anchor, href);
  });
  container.querySelectorAll('code').forEach((code) => {
    const text = code.textContent ?? '';
    if (!code.closest('pre') && wanted.has(text)) mark(code, text);
  });
  const pattern = new RegExp(
    `(?<=(?:^|\\s)[('"“]*)(${[...wanted]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join('|')})(?=[),.!?;:'"”]*(?:\\s|$))`,
    'g'
  );
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('a, code, pre, [data-preview-reference]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parts = (node.nodeValue ?? '').split(pattern);
    if (parts.length === 1) continue;
    node.replaceWith(
      ...parts.map((part, index) => {
        if (index % 2 === 0) return part;
        const span = document.createElement('span');
        span.className = 'preview-reference';
        span.textContent = part;
        mark(span, part);
        return span;
      })
    );
  }
}
