import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.tsx';
import { neoDraftPayload, neoQuoteExcerpt } from '../neo-intake.ts';

afterEach(cleanup);

describe('neoDraftPayload quoted source rendering', () => {
  it('renders hostile source literally and keeps the new reply outside its quote', async () => {
    const source =
      '<script>alert(1)</script>\r[link](javascript:alert(1))\r\n![image](https://example.com/image.png)\nhttps://example.com\nwww.example.com\nuser@example.com\n    indented\n\twith tab\n```html\n<b>raw & text</b>\n$$x$$\n1. list item\n**bold**\n\\backslash\n> nested';
    const reply = '> My own quoted words\n\n**My own emphasis**';
    const anchor = 'neo-message-neo%3Aroot-ask()\n!';
    const payload = neoDraftPayload({
      sessionId: 'neo:root',
      requestId: 'new-ask',
      text: reply,
      quote: { author: 'Neo', text: source, anchor },
    });
    expect(typeof payload.content).toBe('string');
    const content = payload.content as string;
    expect(content.endsWith(`\n\nYour reply:\n\n${reply}`)).toBe(true);
    const { container } = render(<MarkdownRenderer content={content} />);
    const link = await screen.findByRole('link', { name: 'Neo' });
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).toBe(anchor);
    expect(
      Array.from(container.querySelectorAll('a'))
        .slice(1)
        .map((link) => link.getAttribute('href'))
    ).toEqual([
      'https://example.com/image.png',
      'https://example.com',
      'http://www.example.com',
      'mailto:user@example.com',
    ]);
    expect(container.querySelectorAll('script, img, pre, .katex')).toHaveLength(0);
    const quotes = container.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(2);
    expect(quotes[0].textContent?.replace(/\s+/g, ' ').trim()).toBe(
      source.replace(/\s+/g, ' ').trim()
    );
    expect(quotes[0].querySelectorAll('strong, b, ol, li')).toHaveLength(0);
    expect(quotes[1].textContent).toContain('My own quoted words');
    expect(screen.getByText('My own emphasis', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Your reply:')).toBeTruthy();
  });

  it('bounds transmitted context without truncating the user reply', () => {
    const reply = 'My reply '.repeat(1000);
    const payload = neoDraftPayload({
      sessionId: 'neo:root',
      requestId: 'new-ask',
      text: reply,
      quote: { author: 'You', text: 'a'.repeat(50000), anchor: 'source' },
    });
    const content = payload.content as string;
    expect(content).toContain('quote shortened');
    expect(content.length).toBeLessThan(reply.length + 4200);
    expect(content.endsWith(`Your reply:\n\n${reply}`)).toBe(true);
  });
});

describe('neoQuoteExcerpt', () => {
  it('keeps the exact boundary and normalizes all source line endings', () => {
    expect(neoQuoteExcerpt('a'.repeat(4000))).toBe('a'.repeat(4000));
    expect(neoQuoteExcerpt('a\rb\r\nc\u2028d\u2029e')).toBe('a\nb\nc\nd\ne');
  });

  it('counts Unicode characters without splitting surrogate pairs', () => {
    const excerpt = neoQuoteExcerpt('😀'.repeat(4001));
    expect(Array.from(excerpt)).toHaveLength(4000);
    expect(excerpt.endsWith('\n… (quote shortened)')).toBe(true);
    expect(excerpt.replaceAll('😀', '')).toBe('\n… (quote shortened)');
  });
});
