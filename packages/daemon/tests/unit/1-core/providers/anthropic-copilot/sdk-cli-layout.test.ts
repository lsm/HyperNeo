import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

describe('@github/copilot-sdk bundled runtime layout', () => {
  it('ships the platform runtime packages the SDK client spawns by default', () => {
    const entryUrl = import.meta.resolve('@github/copilot-sdk');
    const sdkRoot = dirname(dirname(fileURLToPath(entryUrl)));
    const meta = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf-8')) as {
      name?: string;
      optionalDependencies?: Record<string, string>;
    };
    expect(meta.name).toBe('@github/copilot-sdk');

    const expectedPlatforms = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'linuxmusl-arm64',
      'linuxmusl-x64',
      'win32-arm64',
      'win32-x64',
    ];
    for (const platform of expectedPlatforms) {
      expect(meta.optionalDependencies?.[`@github/copilot-sdk-${platform}`]).toBeDefined();
    }
    expect(existsSync(join(sdkRoot, 'dist', 'client.js'))).toBe(true);
  });
});
