import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const FIRST_USE_DOWNLOAD_TIMEOUT_MS = 300_000;
const SDK_PACKAGE_PATH = 'packages/daemon/node_modules/@github/copilot-sdk/package.json';

type Observed = { path: string; source: string; version: string };

function hasNodeModulesAbove(directory: string): boolean {
  const parent = dirname(directory);
  return (
    existsSync(join(directory, 'node_modules')) ||
    (parent !== directory && hasNodeModulesAbove(parent))
  );
}

function runCheck(binary: string, run: string): Observed {
  const result = spawnSync(binary, ['--hyperneo-copilot-runtime-check'], {
    cwd: run,
    encoding: 'utf8',
    timeout: FIRST_USE_DOWNLOAD_TIMEOUT_MS,
    env: {
      HOME: join(run, 'home'),
      USERPROFILE: join(run, 'home'),
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: join(run, 'tmp'),
      TMP: join(run, 'tmp'),
      TMPDIR: join(run, 'tmp'),
      HYPERNEO_DATA_DIR: join(run, 'data'),
      NODE_ENV: 'test',
    },
  });
  if (result.status !== 0)
    throw new Error(
      `Copilot client failed to start (status ${result.status}, ${result.error ?? 'no spawn error'}):\n${result.stdout}\n${result.stderr}`
    );
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
}

function expectRuntime(observed: Observed, source: string, run: string, version: string): void {
  if (observed.source !== source || !observed.path.startsWith(join(run, 'data')))
    throw new Error(`Expected a ${source} runtime in ${run}: ${JSON.stringify(observed)}`);
  if (observed.version !== version)
    throw new Error(`Expected Copilot runtime ${version}: ${JSON.stringify(observed)}`);
}

export function checkCopilotRuntime(compiledBinary: string): void {
  const sdkPackage = join(import.meta.dir, '..', SDK_PACKAGE_PATH);
  const { copilotCliVersion } = JSON.parse(readFileSync(sdkPackage, 'utf8'));
  const run = mkdtempSync(join(tmpdir(), 'hyperneo-copilot-check-'));
  try {
    if (hasNodeModulesAbove(run)) throw new Error(`${run} can reach a node_modules folder`);
    for (const part of ['home', 'data', 'tmp']) mkdirSync(join(run, part));
    const binary = join(run, basename(compiledBinary));
    copyFileSync(resolve(compiledBinary), binary);
    expectRuntime(runCheck(binary, run), 'download', run, copilotCliVersion);
    expectRuntime(runCheck(binary, run), 'cache', run, copilotCliVersion);
    console.log(`PASS: ${basename(compiledBinary)} started Copilot ${copilotCliVersion}`);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [compiledBinary] = process.argv.slice(2);
  if (!compiledBinary) throw new Error('usage: copilot-runtime-check.ts <compiled-binary>');
  checkCopilotRuntime(compiledBinary);
}
