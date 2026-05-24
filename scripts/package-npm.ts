/**
 * Assembles npm packages from compiled binaries.
 * Takes binaries from dist/bin/ and creates publishable packages in dist/npm/.
 *
 * Usage: bun run scripts/package-npm.ts [--version 0.1.0]
 */

import { mkdirSync, copyFileSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BIN_DIR = join(ROOT, 'dist', 'bin');
const NPM_DIR = join(ROOT, 'dist', 'npm');

// Read version from root package.json or CLI args
const versionIdx = process.argv.indexOf('--version');
const VERSION =
  versionIdx !== -1
    ? process.argv[versionIdx + 1]
    : JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf-8')).version;

const PLATFORMS = [
  { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { target: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { target: 'linux-x64', os: 'linux', cpu: 'x64' },
  { target: 'linux-arm64', os: 'linux', cpu: 'arm64' },
];

console.log(`Packaging npm packages (version ${VERSION})...\n`);

// 1. Create platform-specific packages
for (const { target, os, cpu } of PLATFORMS) {
  const pkgName = `@neokai/cli-${target}`;
  const pkgDir = join(NPM_DIR, `cli-${target}`);
  const binDir = join(pkgDir, 'bin');

  mkdirSync(binDir, { recursive: true });

  // Copy binary
  const srcBinary = join(BIN_DIR, `kai-${target}`);
  const destBinary = join(binDir, 'kai');

  try {
    copyFileSync(srcBinary, destBinary);
    chmodSync(destBinary, 0o755);
  } catch {
    console.warn(`  Warning: Binary not found: ${srcBinary} (skipping ${pkgName})`);
    continue;
  }

  // Write package.json
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: pkgName,
        version: VERSION,
        description: `NeoKai binary for ${os} ${cpu}`,
        os: [os],
        cpu: [cpu],
        bin: { kai: 'bin/kai' },
        files: ['bin/'],
        license: 'MIT',
        repository: {
          type: 'git',
          url: 'https://github.com/lsm/neokai',
        },
      },
      null,
      2
    )
  );

  console.log(`  Created ${pkgName}`);
}

// 2. Create main neokai package
const mainDir = join(NPM_DIR, 'neokai');
const mainBinDir = join(mainDir, 'bin');
mkdirSync(mainBinDir, { recursive: true });

// Copy launcher script
copyFileSync(join(ROOT, 'npm', 'neokai', 'bin', 'kai.js'), join(mainBinDir, 'kai.js'));
chmodSync(join(mainBinDir, 'kai.js'), 0o755);

// Write main package.json
const optionalDeps: Record<string, string> = {};
for (const { target } of PLATFORMS) {
  optionalDeps[`@neokai/cli-${target}`] = VERSION;
}

writeFileSync(
  join(mainDir, 'package.json'),
  JSON.stringify(
    {
      name: 'neokai',
      version: VERSION,
      description: 'NeoKai - Claude Agent SDK Web Interface',
      bin: { kai: 'bin/kai.js' },
      optionalDependencies: optionalDeps,
      files: ['bin/'],
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'https://github.com/lsm/neokai',
      },
    },
    null,
    2
  )
);

console.log(`  Created neokai (main wrapper)`);
console.log(`\nAll packages created in ${NPM_DIR}`);
console.log(`\nTo publish, run:`);
for (const { target } of PLATFORMS) {
  console.log(`  cd dist/npm/cli-${target} && npm publish --access public`);
}
console.log(`  cd dist/npm/neokai && npm publish --access public`);
