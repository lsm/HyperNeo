import { describe, expect, it } from 'vitest';
import { decideArtifactImage, decideArtifactLink } from '../artifact-link-policy.ts';

describe('decideArtifactLink', () => {
  it('keeps in-document fragments as plain anchors', () => {
    expect(decideArtifactLink('#install')).toEqual({ kind: 'anchor', href: '#install' });
  });

  it('turns validated web and mail links into explicit external actions', () => {
    expect(decideArtifactLink(' https://example.com/docs?a=1 ')).toEqual({
      kind: 'external',
      url: 'https://example.com/docs?a=1',
    });
    expect(decideArtifactLink('mailto:team@example.com')).toEqual({
      kind: 'external',
      url: 'mailto:team@example.com',
    });
  });

  it.each([
    './notes.md',
    'notes.md',
    '../../.ssh/id_rsa',
    '/etc/passwd',
    'file:///Users/someone/.env',
    'javascript:alert(1)',
    ' JaVa\tScRiPt:alert(1)',
    '//evil.example/x',
    'data:text/html,<script>alert(1)</script>',
    'https://user:secret@example.com/',
    'hyperneo://open',
    '',
  ])('refuses %j, which has no registered bundle entry', (href) => {
    expect(decideArtifactLink(href)).toEqual({ kind: 'refused' });
  });
});

describe('decideArtifactImage', () => {
  it('admits embedded raster images', () => {
    expect(decideArtifactImage('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      kind: 'admit',
      src: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it.each([
    'https://example.com/pixel.png',
    './diagram.png',
    '/Users/someone/photo.jpg',
    'file:///tmp/a.png',
    'data:image/svg+xml,<svg onload="alert(1)"/>',
    'blob:https://example.com/1',
  ])('refuses %j: no remote, filesystem or active image loads', (src) => {
    expect(decideArtifactImage(src)).toEqual({ kind: 'refused' });
  });
});
