import { describe, expect, it } from 'vitest';
import {
  decideMarkdownImage,
  gateSchemeAllowed,
  gateSrcPresent,
  isAllowedMarkdownUrl,
} from '../markdown-image';

describe('markdown-image admission', () => {
  it('admits http, https, and scheme-less srcs unchanged', () => {
    const srcs = [
      'https://e.com/a.png',
      'http://e.com/a.png',
      './assets/pic.png',
      '//cdn.e.com/a.png',
    ];
    for (const src of srcs) {
      expect(decideMarkdownImage({ src, alt: 'a', title: '' })).toEqual({
        kind: 'admit',
        src,
        alt: 'a',
        title: '',
      });
    }
  });

  it('downgrades unsupported image schemes to literal text', () => {
    const srcs = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:m(1)',
      'ftp://e.com/a.png',
      'mailto:user@example.com',
    ];
    for (const src of srcs) {
      expect(decideMarkdownImage({ src, alt: 'x', title: '' })).toEqual({
        kind: 'downgrade',
        text: `![x](${src})`,
      });
    }
  });

  it('downgrades empty srcs', () => {
    expect(decideMarkdownImage({ src: '', alt: 'x', title: '' })).toEqual({
      kind: 'downgrade',
      text: '![x]()',
    });
  });

  it('preserves title in the downgraded text', () => {
    expect(decideMarkdownImage({ src: 'javascript:alert(1)', alt: 'x', title: 'T' })).toEqual({
      kind: 'downgrade',
      text: '![x](javascript:alert(1) "T")',
    });
  });

  it('gateSrcPresent passes candidates with a src through untouched', () => {
    expect(gateSrcPresent({ src: 'https://e.com/a.png', alt: '', title: '' })).toEqual({
      value: { src: 'https://e.com/a.png', alt: '', title: '' },
    });
    expect(gateSrcPresent({ src: '', alt: 'x', title: '' })).toEqual({
      reason: { kind: 'downgrade', text: '![x]()' },
    });
  });

  it('gateSchemeAllowed replaces data URLs with a short image label', () => {
    expect(
      gateSchemeAllowed({ src: 'DATA:IMAGE/PNG;base64,iVBORw0KGgo=', alt: 'chart', title: '' })
    ).toEqual({
      reason: { kind: 'downgrade', text: '[image: chart]' },
    });
    expect(gateSchemeAllowed({ src: 'data:text/html,hi', alt: '', title: '' })).toEqual({
      reason: { kind: 'downgrade', text: '[image]' },
    });
  });

  it('admits links with approved schemes or relative destinations', () => {
    const navigatable = ['https://e.com', 'http://e.com', 'mailto:a@b.c', '/page', './page'];
    for (const href of navigatable) {
      expect(isAllowedMarkdownUrl(href, 'link')).toBe(true);
    }
    const unsafe = ['javascript:alert(1)', 'vbscript:m(1)', 'data:text/html,hi', 'tel:+15551234'];
    for (const href of unsafe) {
      expect(isAllowedMarkdownUrl(href, 'link')).toBe(false);
    }
  });

  it('rejects control-character prefixes the browser URL parser would strip', () => {
    expect(decideMarkdownImage({ src: '\u0000javascript:alert(1)', alt: 'x', title: '' })).toEqual({
      kind: 'downgrade',
      text: '![x](\u0000javascript:alert(1))',
    });
    expect(isAllowedMarkdownUrl('\u0001javascript:alert(1)', 'link')).toBe(false);
    expect(isAllowedMarkdownUrl('\u0000https://e.com', 'link')).toBe(true);
  });
});
