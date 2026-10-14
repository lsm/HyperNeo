import { describe, expect, it } from 'vitest';
import { neoDraftPayload, neoQuoteExcerpt } from '../neo-intake.ts';

describe('neoDraftPayload quote, as iOS ReplyTarget.prefix', () => {
  it('puts "Replying to Neo:" and a Markdown block quote above the reply', () => {
    const payload = neoDraftPayload({
      sessionId: 'neo:root',
      requestId: 'new-ask',
      text: 'Why?',
      quote: { author: 'Neo', text: '  First\n\nSecond  ', anchor: 'source' },
    });
    expect(payload.content).toBe('Replying to Neo:\n> First\n>\n> Second\n\nWhy?');
  });

  it('names your own message as "my earlier message"', () => {
    const payload = neoDraftPayload({
      sessionId: 'neo:root',
      requestId: 'new-ask',
      text: 'Still true?',
      quote: { author: 'You', text: 'Ship it', anchor: 'source' },
    });
    expect(payload.content).toBe('Replying to my earlier message:\n> Ship it\n\nStill true?');
  });

  it('caps the quote without truncating the reply', () => {
    const reply = 'My reply '.repeat(1000);
    const payload = neoDraftPayload({
      sessionId: 'neo:root',
      requestId: 'new-ask',
      text: reply,
      quote: { author: 'You', text: 'a'.repeat(50000), anchor: 'source' },
    });
    const content = payload.content as string;
    expect(content).toContain(`> ${'a'.repeat(500)}…\n\n`);
    expect(content.endsWith(`\n\n${reply}`)).toBe(true);
  });
});

describe('neoQuoteExcerpt', () => {
  it('trims, keeps 500 characters and normalizes line endings', () => {
    expect(neoQuoteExcerpt(` ${'a'.repeat(500)} `)).toBe('a'.repeat(500));
    expect(neoQuoteExcerpt('a'.repeat(501))).toBe(`${'a'.repeat(500)}…`);
    expect(neoQuoteExcerpt('a\rb\r\nc\u2028d\u2029e')).toBe('a\nb\nc\nd\ne');
  });

  it('counts Unicode characters without splitting surrogate pairs', () => {
    const excerpt = neoQuoteExcerpt('😀'.repeat(501));
    expect(Array.from(excerpt)).toHaveLength(501);
    expect(excerpt.replaceAll('😀', '')).toBe('…');
  });
});
