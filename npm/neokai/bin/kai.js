#!/usr/bin/env node

/**
 * NeoKai CLI launcher.
 * Detects the current platform and spawns the correct compiled binary
 * from the matching @neokai/cli-{platform} optional dependency.
 */

const { spawnSync } = require('child_process');

const PLATFORM_MAP = {
  'darwin-arm64': '@neokai/cli-darwin-arm64',
  'darwin-x64': '@neokai/cli-darwin-x64',
  'linux-x64': '@neokai/cli-linux-x64',
  'linux-arm64': '@neokai/cli-linux-arm64',
};

const platformKey = `${process.platform}-${process.arch}`;
const packageName = PLATFORM_MAP[platformKey];

if (!packageName) {
  console.error(
    `Error: NeoKai does not support ${process.platform} ${process.arch}.\n` +
      `Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`
  );
  process.exit(1);
}

let binaryPath;
try {
  binaryPath = require.resolve(`${packageName}/bin/kai`);
} catch {
  console.error(
    `Error: Could not find NeoKai binary for ${platformKey}.\n` +
      `The package ${packageName} may not be installed.\n` +
      `Try reinstalling: npm install -g neokai`
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`Error: Failed to execute NeoKai binary: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
