import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

describe('main.ts import order', () => {
  it('imports config before app so credential discovery precedes provider-service init', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../../../main.ts', import.meta.url)),
      'utf8'
    );
    const configImport = source.indexOf(`from './src/config.ts'`);
    const appImport = source.indexOf(`from './src/app.ts'`);
    expect(configImport).toBeGreaterThanOrEqual(0);
    expect(appImport).toBeGreaterThanOrEqual(0);
    expect(configImport).toBeLessThan(appImport);
  });
});
