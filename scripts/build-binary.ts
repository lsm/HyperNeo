import { readReleaseBuildCommit } from '../packages/daemon/src/lib/build-metadata.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const OUTPUT_DIR = join(ROOT, 'dist', 'bin');

const ALL_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
];

const targetIdx = process.argv.indexOf('--target');
const targetArg = targetIdx !== -1 ? process.argv[targetIdx + 1] : null;

if (targetArg && !ALL_TARGETS.includes(targetArg)) {
  console.error(`Unknown target: ${targetArg}`);
  console.error(`Valid targets: ${ALL_TARGETS.join(', ')}`);
  process.exit(1);
}

const targets = targetArg ? [targetArg] : ALL_TARGETS;

function bun(args: string[], cwd = ROOT) {
  execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });
}

function outputFileForTarget(target: string, binaryName = 'hyperneo'): string {
  const platformArch = target.replace('bun-', '');
  const extension = target.includes('windows') ? '.exe' : '';
  return join(OUTPUT_DIR, `${binaryName}-${platformArch}${extension}`);
}

function verifyBundledDependency(outputPath: string, needle: string): void {
  const binary = readFileSync(outputPath);
  if (!binary.includes(Buffer.from(needle, 'utf8'))) {
    throw new Error(`Compiled binary is missing bundled dependency marker: ${needle}`);
  }
}

console.log('Step 1: Building web frontend...\n');
bun(['run', 'build'], join(ROOT, 'packages', 'web'));

console.log('\nStep 2: Generating embedded assets...\n');
bun(['run', 'scripts/generate-embedded-assets.ts']);

mkdirSync(OUTPUT_DIR, { recursive: true });

const externalFor = (target: string) =>
  target === 'bun-darwin-x64' ? ['--external', '*onnxruntime_binding.node'] : [];

const buildCommit = readReleaseBuildCommit(process.env) ?? '';
const defineBuildCommit = /^[0-9a-f]{40}$/.test(buildCommit)
  ? ['--define', `process.env.HYPERNEO_BUILD_COMMIT="${buildCommit}"`]
  : [];
console.log(`Build commit: ${buildCommit || 'unknown'}`);

for (const target of targets) {
  const outputPath = outputFileForTarget(target);

  console.log(`\nStep 3: Compiling binary for ${target}...`);
  bun([
    'build',
    '--compile',
    `--target=${target}`,
    ...defineBuildCommit,
    ...externalFor(target),
    `--outfile=${outputPath}`,
    'packages/cli/prod-entry.ts',
  ]);
  console.log(`  -> ${outputPath}`);

  console.log('  Verifying Copilot SDK bundle markers...');
  verifyBundledDependency(outputPath, '@github/copilot-sdk');
  verifyBundledDependency(outputPath, 'vscode-jsonrpc');

  if (!target.includes('windows')) {
    const daemonOutputPath = outputFileForTarget(target, 'hyperneod');
    console.log(`  Compiling standalone daemon binary for ${target}...`);
    bun([
      'build',
      '--compile',
      `--target=${target}`,
      ...defineBuildCommit,
      ...externalFor(target),
      `--outfile=${daemonOutputPath}`,
      'packages/cli/daemon-entry.ts',
    ]);
    console.log(`  -> ${daemonOutputPath}`);

    verifyBundledDependency(daemonOutputPath, '@github/copilot-sdk');
    verifyBundledDependency(daemonOutputPath, 'vscode-jsonrpc');
  }
}

console.log('\nBuild complete!');
