#!/usr/bin/env node

/**
 * HyperNeo daemon launcher.
 * Detects the current platform and spawns the correct compiled daemon binary
 * from the matching @hyperneo/hyperneod-{platform} optional dependency.
 */

const { spawnSync } = require('child_process');

const PLATFORM_MAP = {
  'darwin-arm64': '@hyperneo/hyperneod-darwin-arm64',
  'darwin-x64': '@hyperneo/hyperneod-darwin-x64',
  'linux-x64': '@hyperneo/hyperneod-linux-x64',
  'linux-arm64': '@hyperneo/hyperneod-linux-arm64',
};

const platformKey = `${process.platform}-${process.arch}`;
const packageName = PLATFORM_MAP[platformKey];

if (!packageName) {
  console.error(
    `Error: hyperneod does not support ${process.platform} ${process.arch}.\n` +
      `Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`
  );
  process.exit(1);
}

let binaryPath;
try {
  binaryPath = require.resolve(`${packageName}/bin/hyperneod`);
} catch {
  console.error(
    `Error: Could not find hyperneod binary for ${platformKey}.\n` +
      `The package ${packageName} may not be installed.\n` +
      `Try reinstalling: npm install -g hyperneod`
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`Error: Failed to execute hyperneod binary: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
