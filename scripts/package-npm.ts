import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BIN_DIR = process.env.HYPERNEO_PACKAGE_BIN_DIR ?? join(ROOT, 'dist', 'bin');
const NPM_DIR = process.env.HYPERNEO_PACKAGE_NPM_DIR ?? join(ROOT, 'dist', 'npm');

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
  { target: 'windows-x64', os: 'win32', cpu: 'x64' },
];

const DAEMON_PLATFORMS = PLATFORMS.filter(({ os }) => os !== 'win32');

const PRODUCTS = [
  {
    binaryName: 'hyperneo',
    pkgPrefix: 'cli',
    wrapperDir: 'hyperneo',
    description: 'HyperNeo binary for',
    mainDescription: 'HyperNeo - Claude Agent SDK Web Interface',
    platforms: PLATFORMS,
  },
  {
    binaryName: 'hyperneod',
    pkgPrefix: 'hyperneod',
    wrapperDir: 'hyperneod',
    description: 'HyperNeo daemon binary for',
    mainDescription: 'HyperNeo standalone daemon binary (no web UI)',
    platforms: DAEMON_PLATFORMS,
  },
];

console.log(`Packaging npm packages (version ${VERSION})...\n`);

for (const { binaryName, pkgPrefix, description, platforms } of PRODUCTS) {
  for (const { target, os, cpu } of platforms) {
    const pkgName = `@hyperneo/${pkgPrefix}-${target}`;
    const pkgDir = join(NPM_DIR, `${pkgPrefix}-${target}`);
    const binDir = join(pkgDir, 'bin');
    const ext = os === 'win32' ? '.exe' : '';

    const srcBinary = join(BIN_DIR, `${binaryName}-${target}${ext}`);
    const destBinary = join(binDir, `${binaryName}${ext}`);

    if (!existsSync(srcBinary)) {
      console.warn(`  Warning: Binary not found: ${srcBinary} (skipping ${pkgName})`);
      continue;
    }

    mkdirSync(binDir, { recursive: true });
    copyFileSync(srcBinary, destBinary);
    chmodSync(destBinary, 0o755);

    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: pkgName,
          version: VERSION,
          description: `${description} ${os} ${cpu}`,
          os: [os],
          cpu: [cpu],
          bin: { [binaryName]: `bin/${binaryName}${ext}` },
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
}

for (const { binaryName, pkgPrefix, wrapperDir, mainDescription, platforms } of PRODUCTS) {
  const mainDir = join(NPM_DIR, wrapperDir);
  const mainBinDir = join(mainDir, 'bin');
  mkdirSync(mainBinDir, { recursive: true });

  copyFileSync(
    join(ROOT, 'npm', wrapperDir, 'bin', `${binaryName}.js`),
    join(mainBinDir, `${binaryName}.js`)
  );
  chmodSync(join(mainBinDir, `${binaryName}.js`), 0o755);

  const optionalDeps: Record<string, string> = {};
  for (const { target } of platforms) {
    optionalDeps[`@hyperneo/${pkgPrefix}-${target}`] = VERSION;
  }

  writeFileSync(
    join(mainDir, 'package.json'),
    JSON.stringify(
      {
        name: binaryName,
        version: VERSION,
        description: mainDescription,
        bin: { [binaryName]: `bin/${binaryName}.js` },
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

  console.log(`  Created ${binaryName} (main wrapper)`);
}

console.log(`\nAll packages created in ${NPM_DIR}`);
console.log(`\nTo publish, run:`);
for (const { pkgPrefix, wrapperDir, platforms } of PRODUCTS) {
  for (const { target } of platforms) {
    console.log(`  cd dist/npm/${pkgPrefix}-${target} && npm publish --access public`);
  }
  console.log(`  cd dist/npm/${wrapperDir} && npm publish --access public`);
}
