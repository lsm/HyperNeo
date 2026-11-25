import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktop = import.meta.dir;
const root = resolve(desktop, '../..');
const tauri = join(desktop, 'src-tauri');
const target = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
const bunTarget = new Map([
  ['aarch64-apple-darwin', 'bun-darwin-arm64'],
  ['x86_64-apple-darwin', 'bun-darwin-x64'],
  ['x86_64-pc-windows-msvc', 'bun-windows-x64'],
  ['x86_64-unknown-linux-gnu', 'bun-linux-x64'],
  ['aarch64-unknown-linux-gnu', 'bun-linux-arm64'],
]).get(target);
if (!bunTarget) throw new Error(`Unsupported target: ${target}`);

execFileSync(process.execPath, ['run', 'scripts/build-binary.ts', '--target', bunTarget], {
  cwd: root,
  stdio: 'inherit',
});

const extension = bunTarget.startsWith('bun-windows-') ? '.exe' : '';
const binaries = join(tauri, 'binaries');
const bundled = join(binaries, `hyperneo-${target}${extension}`);
mkdirSync(binaries, { recursive: true });
copyFileSync(join(root, 'dist', 'bin', `hyperneo-${bunTarget.slice(4)}${extension}`), bundled);
if (process.platform !== 'win32') chmodSync(bundled, 0o755);
process.stdout.write(`Sidecar binary built: ${bundled}\n`);

if (process.argv.includes('--dev')) {
  const debug = join(resolve(tauri, process.env.CARGO_TARGET_DIR || 'target'), 'debug');
  mkdirSync(debug, { recursive: true });
  copyFileSync(bundled, join(debug, `hyperneo${extension}`));
}
