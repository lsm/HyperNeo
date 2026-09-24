#!/usr/bin/env node

/**
 * HyperNeo CLI launcher.
 * Detects the current platform and spawns the correct compiled binary
 * from the matching @hyperneo/cli-{platform} optional dependency.
 */

const { spawnSync } = require('child_process');

const PLATFORM_MAP = {
  'darwin-arm64': '@hyperneo/cli-darwin-arm64',
  'darwin-x64': '@hyperneo/cli-darwin-x64',
  'linux-x64': '@hyperneo/cli-linux-x64',
  'linux-arm64': '@hyperneo/cli-linux-arm64',
  'win32-x64': '@hyperneo/cli-windows-x64',
};

const platformKey = `${process.platform}-${process.arch}`;
const packageName = PLATFORM_MAP[platformKey];

if (!packageName) {
  console.error(
    `Error: HyperNeo does not support ${process.platform} ${process.arch}.\n` +
      `Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`
  );
  process.exit(1);
}

const binaryName = process.platform === 'win32' ? 'hyperneo.exe' : 'hyperneo';

let binaryPath;
try {
  binaryPath = require.resolve(`${packageName}/bin/${binaryName}`);
} catch {
  console.error(
    `Error: Could not find HyperNeo binary for ${platformKey}.\n` +
      `The package ${packageName} may not be installed.\n` +
      `Try reinstalling: npm install -g hyperneo`
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`Error: Failed to execute HyperNeo binary: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
