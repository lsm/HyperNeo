import { describe, expect, it } from 'vitest';
import {
  decideMarkdownImage,
  gateSchemeAllowed,
  gateSrcPresent,
  isNavigatableHref,
} from '../markdown-image';

describe('markdown-image admission', () => {
  it('admits http, https, data image, and scheme-less srcs unchanged', () => {
    const srcs = [
      'https://e.com/a.png',
      'http://e.com/a.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'DATA:IMAGE/PNG;base64,iVBORw0KGgo=',
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

  it('downgrades javascript, unknown, and non-image data srcs to literal text', () => {
    const srcs = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:m(1)',
      'ftp://e.com/a.png',
      'data:text/html;base64,PGI+',
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

  it('gateSchemeAllowed rejects non-image schemes', () => {
    expect(
      gateSchemeAllowed({ src: 'data:image/png;base64,iVBORw0KGgo=', alt: '', title: '' })
    ).toEqual({
      value: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: '', title: '' },
    });
    expect(gateSchemeAllowed({ src: 'data:text/html,hi', alt: '', title: '' })).toEqual({
      reason: { kind: 'downgrade', text: '![](data:text/html,hi)' },
    });
  });

  it('delegates hrefs for navigatable schemes only', () => {
    const navigatable = [
      'https://e.com',
      'http://e.com',
      'mailto:a@b.c',
      'tel:+15551234',
      '/page',
      './page',
    ];
    for (const href of navigatable) {
      expect(isNavigatableHref(href)).toBe(true);
    }
    const unsafe = ['javascript:alert(1)', 'vbscript:m(1)', 'data:text/html,hi', 'JAVASCRIPT:x'];
    for (const href of unsafe) {
      expect(isNavigatableHref(href)).toBe(false);
    }
  });

  it('rejects control-character prefixes the browser URL parser would strip', () => {
    expect(decideMarkdownImage({ src: '\u0000javascript:alert(1)', alt: 'x', title: '' })).toEqual({
      kind: 'downgrade',
      text: '![x](\u0000javascript:alert(1))',
    });
    expect(isNavigatableHref('\u0001javascript:alert(1)')).toBe(false);
    expect(isNavigatableHref('\u0000https://e.com')).toBe(true);
  });
});
