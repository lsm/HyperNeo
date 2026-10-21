import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_HTML_CSP,
  prepareArtifactHtml,
} from '../../../../src/lib/artifacts/html-preview.ts';

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function head(document: string) {
  return document.slice(document.indexOf('<head>'), document.indexOf('</head>'));
}

function expectInert(document: string) {
  const lower = document.toLowerCase();
  expect(lower).not.toContain('<script');
  expect(lower).not.toMatch(/\son[a-z]+\s*=/);
  expect(lower).not.toContain('javascript:');
  expect(lower).not.toContain('vbscript:');
  expect(lower).not.toMatch(
    /<(iframe|frame|object|embed|form|input|button|select|textarea|svg|math|base|link|template|noscript)\b/
  );
  expect(lower).not.toMatch(/https?:\/\//);
  expect(lower).not.toContain('evil.example');
  expect(lower).not.toContain('expression(');
  expect(lower).not.toContain('@import');
  expect(head(document).match(/<meta /g)).toHaveLength(2);
  expect(head(document)).toMatch(
    /^<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="[^"]+">/
  );
  expect(document).toContain(ARTIFACT_HTML_CSP.replaceAll("'", '&#x27;'));
}

describe('artifact HTML preview document', () => {
  test('keeps a static report readable: text, layout styles and embedded raster images', () => {
    const prepared = prepareArtifactHtml(
      `<!doctype html><html><head><title>Layout report</title><style>.ok{color:#123}</style></head>
      <body><h1 class="ok" style="margin:4px">Layout report</h1><table><tr><td colspan="2">Cell</td></tr></table>
      <img alt="Chart" src="${pixel}" width="1" height="1"><p>Done &amp; checked</p></body></html>`
    );
    expectInert(prepared.document);
    expect(prepared.document).toContain('<title>Layout report</title>');
    expect(prepared.document).toContain('<style>.ok{color:#123}</style>');
    expect(prepared.document).toContain('<h1 class="ok" style="margin:4px">Layout report</h1>');
    expect(prepared.document).toContain('<td colspan="2">Cell</td>');
    expect(prepared.document).toContain(`<img alt="Chart" src="${pixel}" width="1" height="1">`);
    expect(prepared.document).toContain('Done &#x26; checked');
    expect(prepared.scriptsRemoved).toBe(false);
    expect(prepared.links).toEqual([]);
  });

  test.each([
    ['script tags', '<script>parent.steal()</script><p>Kept</p>'],
    [
      'event handlers',
      '<p onclick="steal()" ONLOAD=steal() onmouseover = steal()>Kept</p><body onload="x()">',
    ],
    [
      'javascript: links',
      '<a href="javascript:steal()">Kept</a><a href=" JaVaScRiPt:steal()">Kept</a>',
    ],
    [
      'data: documents',
      '<a href="data:text/html,<script>x()</script>">Kept</a><img src="data:text/html;base64,PHNjcmlwdD4=">',
    ],
    [
      'remote assets',
      '<img src="https://evil.example/p.png"><link rel="stylesheet" href="http://evil.example/a.css"><video src="https://evil.example/v.mp4"></video><p style="background:url(https://evil.example/x.png)">Kept</p>',
    ],
    [
      'forms',
      '<form action="https://evil.example"><input name="token"><button>Send</button><textarea>a</textarea></form><p>Kept</p>',
    ],
    [
      'frames and objects',
      '<iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x"><frameset><frame src="y"></frameset><p>Kept</p>',
    ],
    [
      'meta refresh and authored CSP',
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><meta http-equiv="Content-Security-Policy" content="script-src *"><base href="https://evil.example/"><p>Kept</p>',
    ],
    [
      'CSS url, import and expression',
      '<style>@import url("https://evil.example/a.css");p{background:url(//evil.example/x);width:expression(alert(1))}</style><p style="width:expression(alert(1));background-image:url(\'http://evil.example/y\')">Kept</p>',
    ],
    [
      'CSS escapes hiding url()',
      '<style>p{background:u\\72l(//evil.example/x)}</style><p style="background:u\\rl(//evil.example)">Kept</p>',
    ],
    [
      'SVG and MathML scripts',
      '<svg onload="x()"><script>x()</script><a xlink:href="javascript:x()"><text>t</text></a></svg><math><mtext><a href="javascript:x()">m</a></mtext></math><p>Kept</p>',
    ],
    [
      'wrapper breakout',
      '</title></style></head><body></html><meta http-equiv="refresh" content="0"><script>x()</script><!-- --><!--<script>x()</script>--><plaintext><script>x()</script><p>Kept</p>',
    ],
    ['markup inside a stylesheet', '<style><script>alert(1)</script></style><p>Kept</p>'],
    [
      'comment-split CSS url()',
      '<style>p{background:url/*c*/("//evil.example/x")}</style><p style="background:url/**/(//evil.example/y)">Kept</p>',
    ],
    [
      'template and noscript',
      '<template><script>x()</script></template><noscript><img src="https://evil.example"></noscript><p>Kept</p>',
    ],
  ])('neutralizes %s', (_name, html) => {
    const prepared = prepareArtifactHtml(html);
    expectInert(prepared.document);
    expect(prepared.document).toContain('Kept');
  });

  test('says when scripts were removed so the host can show the notice', () => {
    expect(prepareArtifactHtml('<script>x()</script><p>Chart</p>').scriptsRemoved).toBe(true);
    expect(prepareArtifactHtml('<button onclick="x()">Go</button>').scriptsRemoved).toBe(true);
    expect(prepareArtifactHtml('<p>Static</p>').scriptsRemoved).toBe(false);
    for (const page of [
      '<body onload="steal()"><p>S</p></body>',
      '<html onclick="steal()"><p>S</p>',
      '<template><script>x()</script></template><p>S</p>',
      '<svg><g onclick="x()"></g></svg><p>S</p>',
    ])
      expect(prepareArtifactHtml(page).scriptsRemoved).toBe(true);
  });

  test('keeps child selectors and quoted ampersands in a stylesheet intact', () => {
    expect(
      prepareArtifactHtml('<style>ul>li{color:red}p::after{content:"&"}</style><p>K</p>').document
    ).toContain('<style>ul>li{color:red}p::after{content:"&"}</style>');
  });

  test('bounds the host link list a page can produce', () => {
    const anchor = `<a href="https://example.com/x">${'t'.repeat(500)}</a>`;
    const prepared = prepareArtifactHtml(anchor.repeat(300));
    expect(prepared.links).toHaveLength(200);
    expect(prepared.links.every((link) => link.text.length === 200)).toBe(true);
  });

  test('turns safe web links into host actions outside the frame, keeping their text', () => {
    const prepared = prepareArtifactHtml(
      '<p><a href="https://github.com/lsm/HyperNeo/pull/1">PR one</a> and <a href="mailto:a@example.com">mail</a> and <a href="#top">top</a> and <a href="ftp://x">ftp</a></p>'
    );
    expectInert(prepared.document);
    expect(prepared.document).toContain('PR one and mail and top and ftp');
    expect(prepared.links).toEqual([
      { text: 'PR one', href: 'https://github.com/lsm/HyperNeo/pull/1' },
      { text: 'mail', href: 'mailto:a@example.com' },
    ]);
  });

  test('serves a registered hostile page only as the prepared document, under current authority', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-html-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../.claude/skills/verify/preview-html.ts', import.meta.url)
          ),
          root,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 60000,
        }
      );
      expect(JSON.parse(output)).toEqual({
        inertDocument: true,
        cspFirst: true,
        textKept: true,
        scriptsNoticed: true,
        hostLinks: true,
        typeRefused: true,
        sizeRefused: true,
        authorityRechecked: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
