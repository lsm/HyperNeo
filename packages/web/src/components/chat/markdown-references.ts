import { t } from '../../lib/i18n/index.ts';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mark(element: Element, reference: string, label = reference) {
  element.setAttribute('data-preview-reference', reference);
  if (element.tagName === 'A') return;
  element.setAttribute('role', 'link');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-label', t('artifact.openNamed', { name: label }));
}

export function markPreviewReferences(
  container: HTMLElement,
  references: readonly string[],
  labels: ReadonlyMap<string, { path: string; label: string }> = new Map()
) {
  if (references.length === 0 && labels.size === 0) return;
  const clickable = new Set(references);
  const wanted = new Set([...references, ...labels.keys()]);
  const apply = (element: Element, reference: string) => {
    const display = labels.get(reference);
    if (display && (element.textContent === reference || element.textContent === display.path)) {
      element.setAttribute('data-original-reference', element.textContent);
      element.textContent = display.label;
    }
    if (clickable.has(reference)) mark(element, reference, display?.label);
  };
  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    if (wanted.has(href)) apply(anchor, href);
  });
  container.querySelectorAll('code').forEach((code) => {
    const text = code.textContent ?? '';
    if (!code.closest('pre') && wanted.has(text)) apply(code, text);
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
        if (clickable.has(part)) span.className = 'preview-reference';
        span.textContent = part;
        apply(span, part);
        return span;
      })
    );
  }
}
