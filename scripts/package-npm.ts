import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BIN_DIR = join(ROOT, 'dist', 'bin');
const NPM_DIR = join(ROOT, 'dist', 'npm');

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

for (const { target, os, cpu } of PLATFORMS) {
  const pkgName = `@hyperneo/cli-${target}`;
  const pkgDir = join(NPM_DIR, `cli-${target}`);
  const binDir = join(pkgDir, 'bin');

  mkdirSync(binDir, { recursive: true });

  const srcBinary = join(BIN_DIR, `hyperneo-${target}`);
  const destBinary = join(binDir, 'hyperneo');

  try {
    copyFileSync(srcBinary, destBinary);
    chmodSync(destBinary, 0o755);
  } catch {
    console.warn(`  Warning: Binary not found: ${srcBinary} (skipping ${pkgName})`);
    continue;
  }

  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: pkgName,
        version: VERSION,
        description: `HyperNeo binary for ${os} ${cpu}`,
        os: [os],
        cpu: [cpu],
        bin: { hyperneo: 'bin/hyperneo' },
        files: ['bin/'],
        license: 'Apache-2.0',
        repository: {
          type: 'git',
          url: 'https://github.com/lsm/HyperNeo',
        },
      },
      null,
      2
    )
  );

  console.log(`  Created ${pkgName}`);
}

const mainDir = join(NPM_DIR, 'hyperneo');
const mainBinDir = join(mainDir, 'bin');
mkdirSync(mainBinDir, { recursive: true });

copyFileSync(join(ROOT, 'npm', 'hyperneo', 'bin', 'hyperneo.js'), join(mainBinDir, 'hyperneo.js'));
chmodSync(join(mainBinDir, 'hyperneo.js'), 0o755);

const optionalDeps: Record<string, string> = {};
for (const { target } of PLATFORMS) {
  optionalDeps[`@hyperneo/cli-${target}`] = VERSION;
}

writeFileSync(
  join(mainDir, 'package.json'),
  JSON.stringify(
    {
      name: 'hyperneo',
      version: VERSION,
      description: 'HyperNeo - Claude Agent SDK Web Interface',
      bin: { hyperneo: 'bin/hyperneo.js' },
      optionalDependencies: optionalDeps,
      files: ['bin/'],
      license: 'Apache-2.0',
      repository: {
        type: 'git',
        url: 'https://github.com/lsm/HyperNeo',
      },
    },
    null,
    2
  )
);

console.log(`  Created hyperneo (main wrapper)`);
console.log(`\nAll packages created in ${NPM_DIR}`);
console.log(`\nTo publish, run:`);
for (const { target } of PLATFORMS) {
  console.log(`  cd dist/npm/cli-${target} && npm publish --access public`);
}
console.log(`  cd dist/npm/hyperneo && npm publish --access public`);
