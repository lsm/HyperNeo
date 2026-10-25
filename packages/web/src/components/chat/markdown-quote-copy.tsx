import { render } from 'preact';
import { CopyButton } from '../ui/CopyButton.tsx';

function quoteText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent || '';
    const text = node.previousSibling?.nodeName === 'BR' ? value.replace(/^\n/, '') : value;
    return /^\s*\n\s*$/.test(text) ? '' : text;
  }
  if (!(node instanceof Element)) return '';
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
  if (node.tagName === 'TR') {
    return `${Array.from(node.children, quoteText).join('\t')}\n`;
  }
  const text = Array.from(node.childNodes, quoteText).join('');
  if (node.tagName === 'LI') return `${text.trim()}\n`;
  if (/^(P|BLOCKQUOTE|PRE|UL|OL|TABLE|H[1-6])$/.test(node.tagName)) {
    return `${text.trim()}\n\n`;
  }
  return text;
}

export function attachQuoteCopyButtons(container: HTMLElement) {
  if (!container.classList.contains('neo-markdown')) return [];
  const quotes = Array.from(container.querySelectorAll('blockquote'), (quote) => ({
    quote,
    text: quoteText(quote)
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  }));
  return quotes.map(({ quote, text }) => {
    const mount = document.createElement('div');
    mount.className = 'neo-quote-copy';
    quote.prepend(mount);
    render(
      <CopyButton text={text} label="Copy quote" showFeedback class="neo-quote-copy-button" />,
      mount
    );
    return mount;
  });
}
