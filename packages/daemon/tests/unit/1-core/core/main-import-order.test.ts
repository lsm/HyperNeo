/**
 * Guards main.ts's config-first import contract (Codex review, PR #2499).
 *
 * provider-service.ts freezes env-derived routing (ANTHROPIC_BASE_URL, model
 * overrides, timeouts) at module initialization, and credential discovery in
 * config.ts is what populates those values (env → credentials file → keychain →
 * settings.json). If an import organizer ever sorts `./src/app` ahead of
 * `./src/config`, the app import evaluates provider-service first and those
 * values are captured undefined.
 */
import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

describe('main.ts import order', () => {
  it('imports config before app so credential discovery precedes provider-service init', async () => {
    // import.meta.dir is Bun-only; this file also runs under Vitest, which
    // only provides the standard import.meta.url.
    const source = await readFile(
      fileURLToPath(new URL('../../../../main.ts', import.meta.url)),
      'utf8'
    );
    const configImport = source.indexOf(`from './src/config'`);
    const appImport = source.indexOf(`from './src/app'`);
    expect(configImport).toBeGreaterThanOrEqual(0);
    expect(appImport).toBeGreaterThanOrEqual(0);
    expect(configImport).toBeLessThan(appImport);
  });
});
