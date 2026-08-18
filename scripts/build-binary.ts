import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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

function run(cmd: string) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function outputFileForTarget(target: string): string {
  const platformArch = target.replace('bun-', '');
  const extension = target.includes('windows') ? '.exe' : '';
  return join(OUTPUT_DIR, `hyperneo-${platformArch}${extension}`);
}

function verifyBundledDependency(outputPath: string, needle: string): void {
  const escapedNeedle = needle.replace(/'/g, "'\\''");
  try {
    execSync(`strings '${outputPath}' | grep '${escapedNeedle}'`, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    throw new Error(`Compiled binary is missing bundled dependency marker: ${needle}`);
  }
}

console.log('Step 1: Building web frontend...\n');
run('cd packages/web && bun run build');

console.log('\nStep 2: Generating embedded assets...\n');
run('bun run scripts/generate-embedded-assets.ts');

mkdirSync(OUTPUT_DIR, { recursive: true });

for (const target of targets) {
  const outputPath = outputFileForTarget(target);

  console.log(`\nStep 3: Compiling binary for ${target}...`);
  run(`bun build --compile --target=${target} --outfile=${outputPath} packages/cli/prod-entry.ts`);
  console.log(`  -> ${outputPath}`);

  console.log('  Verifying Copilot SDK bundle markers...');
  verifyBundledDependency(outputPath, '@github/copilot-sdk');
  verifyBundledDependency(outputPath, 'vscode-jsonrpc');
}

console.log('\nBuild complete!');
