import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareArtifactHtml } from '../../../../src/lib/artifacts/html-preview.ts';
import { RegisterArtifactInput } from '../../../../src/lib/artifacts/register-operation.ts';
import { artifactBundleLimit } from '../../../../src/lib/artifacts/bundle.ts';

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('registered relative CSS and raster bundles', () => {
  test('refuses repeated asset expansion before constructing an oversized document', () => {
    const assets = new Map([
      ['chart.png', { kind: 'image' as const, data: 'data:image/png;base64,' + 'A'.repeat(4096) }],
    ]);
    expect(prepareArtifactHtml('<img src="chart.png">'.repeat(1024), assets) === null).toBe(true);
  });
  test('refuses aggregate bundle bytes beyond 64 MiB while admitting the exact limit', () => {
    const assets = [{ row: { byte_length: 64 * 1024 * 1024 - 1 } }];
    expect(artifactBundleLimit(1, assets)).toBeNull();
    expect(artifactBundleLimit(2, assets)).toEqual({ accepted: false, reason: 'size_limit' });
  });
  test('accepts explicit registered IDs and rejects unsafe, duplicate or excessive aliases', () => {
    const input = {
      requestId: 'bundle',
      context: { kind: 'todo', id: 't' },
      path: 'report.html',
      title: 'Report',
    };
    const entry = { path: 'styles/theme.css', artifactId: 'css' };
    expect(RegisterArtifactInput.safeParse({ ...input, bundle: [entry] }).success).toBe(true);
    for (const path of [
      '../a.css',
      '/a.css',
      'https://example.com/a.css',
      'a\\b.css',
      'a%2fb.css',
      'a.css?x',
      'a.css#x',
      './a.css',
      'a//b.css',
    ])
      expect(
        RegisterArtifactInput.safeParse({ ...input, bundle: [{ ...entry, path }] }).success
      ).toBe(false);
    expect(RegisterArtifactInput.safeParse({ ...input, bundle: [entry, entry] }).success).toBe(
      false
    );
    expect(
      RegisterArtifactInput.safeParse({
        ...input,
        bundle: Array.from({ length: 64 }, (_, i) => ({ ...entry, path: `${i}.css` })),
      }).success
    ).toBe(false);
    expect(
      RegisterArtifactInput.safeParse({
        ...input,
        bundle: [{ ...entry, sourcePath: '/unregistered' }],
      }).success
    ).toBe(false);
  });

  test('renders only explicit snapshot assets and resolves CSS images relative to the sheet', () => {
    const assets = new Map([
      [
        'styles/theme.css',
        {
          kind: 'css' as const,
          data: '.bundle{color:#13713d;background-image:url(../images/chart.png)}',
        },
      ],
      ['images/chart.png', { kind: 'image' as const, data: pixel }],
    ]);
    const html =
      '<link rel="stylesheet" href="styles/theme.css"><h1 class="bundle">Bundled report</h1><img src="images/chart.png" alt="Captured chart"><img src="unlisted.png" alt="Unlisted"><img src="https://canary.invalid/a.png"><script>escape()</script>';
    const prepared = prepareArtifactHtml(html, assets)!;
    expect(prepared.document).toContain(
      '.bundle{color:#13713d;background-image:url(' + pixel + ')}'
    );
    expect(prepared.document).toContain(`<img src="${pixel}" alt="Captured chart">`);
    expect(prepared.document).not.toContain('Unlisted');
    expect(prepared.document).not.toContain('canary.invalid');
    expect(prepared.document).not.toContain('<script');
    expect(prepared.scriptsRemoved).toBe(true);
    const legacy = prepareArtifactHtml(html)!;
    expect(legacy.document).not.toContain('background-image');
    expect(legacy.document).not.toContain('Captured chart');
  });

  test('never admits network imports, missing aliases or executable assets through CSS', () => {
    const assets = new Map([
      [
        'unsafe.css',
        { kind: 'css' as const, data: '@import "https://canary.invalid/a.css";p{color:red}' },
      ],
      [
        'safe.css',
        {
          kind: 'css' as const,
          data: 'p{background:url(https://canary.invalid/image);mask:url(missing.png);color:#13713d}',
        },
      ],
    ]);
    const prepared = prepareArtifactHtml(
      '<link rel="stylesheet" href="unsafe.css"><link rel="stylesheet" href="safe.css"><p>Kept</p>',
      assets
    )!;
    expect(prepared.document).not.toContain('@import');
    expect(prepared.document).not.toContain('canary.invalid');
    expect(prepared.document).toContain('p{background:none;mask:none;color:#13713d}');
    expect(prepared.document).toContain('Kept');
  });

  test('registers and reopens an authorized immutable bundle through real native operations', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-bundle-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../.claude/skills/verify/preview-bundle.ts', import.meta.url)
          ),
          root,
        ],
        {
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        immutableAssets: true,
        exactSource: true,
        idempotent: true,
        foreignRefused: true,
        restarted: true,
        revoked: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
