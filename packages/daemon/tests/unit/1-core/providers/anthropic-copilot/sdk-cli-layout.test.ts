import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

describe('@github/copilot-sdk bundled CLI layout', () => {
  it('ships the nested ./sdk export and CLI entry the SDK client resolves at construction', () => {
    const sdkRequire = createRequire(import.meta.resolve('@github/copilot-sdk'));
    const searchPaths = sdkRequire.resolve.paths('@github/copilot') ?? [];
    const metaDir = searchPaths
      .map((base) => join(base, '@github', 'copilot'))
      .find((dir) => existsSync(join(dir, 'package.json')));

    expect(metaDir).toBeDefined();

    const meta = JSON.parse(readFileSync(join(metaDir as string, 'package.json'), 'utf-8')) as {
      exports?: Record<string, unknown>;
    };
    expect(meta.exports?.['./sdk']).toBeDefined();
    expect(existsSync(join(metaDir as string, 'sdk', 'index.js'))).toBe(true);
    expect(existsSync(join(metaDir as string, 'index.js'))).toBe(true);
  });
});
