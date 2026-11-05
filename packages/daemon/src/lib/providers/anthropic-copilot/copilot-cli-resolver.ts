import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import daemonPackage from '../../../../package.json' with { type: 'json' };
import {
  describeWriteFailure,
  downloadVerifiedTarball,
  extractPackageFromTarGz,
  isMusl,
  waitForDownload,
} from '../../agent/npm-package-download.ts';
import { isBundledBinary } from '../../agent/sdk-cli-resolver.ts';
import { getDataDir } from '../../data-dir.ts';

const SDK_PACKAGE = '@github/copilot-sdk';

type Host = { platform: string; arch: string; musl: boolean };
type RuntimePackage = { name: string; version: string; wrapper: string; cacheDir: string };
export type CopilotRuntime = {
  path: string;
  source: 'env' | 'node_modules' | 'cache' | 'download';
};

const downloads = new Map<string, Promise<CopilotRuntime>>();

export function resolveCopilotCliPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPath = env.COPILOT_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    try {
      const stat = statSync(envPath);
      if (stat.isFile() && stat.size > 0) {
        return envPath;
      }
    } catch {}
  }
  return undefined;
}

export function copilotRuntimePackage(
  host: Host,
  version: string,
  cacheRoot: string
): RuntimePackage {
  const os = host.platform === 'linux' && host.musl ? 'linuxmusl' : host.platform;
  if (!['darwin', 'linux', 'win32'].includes(host.platform) || !/^(x64|arm64)$/.test(host.arch))
    throw new Error(`Unsupported Copilot platform: ${host.platform}-${host.arch}`);
  const platform = `${os}-${host.arch}`;
  const binary = host.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
  return {
    name: `${SDK_PACKAGE}-${platform}`,
    version,
    wrapper: join('prebuilds', platform, binary),
    cacheDir: join(cacheRoot, `copilot-${version}-${platform}`),
  };
}

function isUsableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function isRuntimeComplete(root: string, wrapper: string): boolean {
  return (
    isUsableFile(join(root, wrapper)) && isUsableFile(join(root, wrapper, '..', 'runtime.node'))
  );
}

function installedPackageRoot(packageName: string): string | undefined {
  try {
    const sdkEntry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    return (createRequire(sdkEntry).resolve.paths(packageName) ?? [])
      .map((base) => join(base, ...packageName.split('/')))
      .find((candidate) => existsSync(join(candidate, 'package.json')));
  } catch {
    return undefined;
  }
}

function configuredRuntime(env: NodeJS.ProcessEnv): CopilotRuntime | undefined {
  const path = resolveCopilotCliPath(env);
  return path ? { path, source: 'env' } : undefined;
}

function localRuntime(target: RuntimePackage, bundled: boolean): CopilotRuntime | undefined {
  const installed = bundled ? undefined : installedPackageRoot(target.name);
  if (installed && isRuntimeComplete(installed, target.wrapper))
    return { path: join(installed, target.wrapper), source: 'node_modules' };
  return isRuntimeComplete(target.cacheDir, target.wrapper)
    ? { path: join(target.cacheDir, target.wrapper), source: 'cache' }
    : undefined;
}

function resolved(runtime?: CopilotRuntime): boolean {
  return runtime !== undefined;
}

async function downloadRuntime(target: RuntimePackage): Promise<CopilotRuntime> {
  const staging = `${target.cacheDir}.${process.pid}.${Date.now()}`;
  const tarball = `${target.cacheDir}.tgz.partial`;
  try {
    await downloadVerifiedTarball(target.name, target.version, tarball);
    await extractPackageFromTarGz(tarball, staging);
    if (!isRuntimeComplete(staging, target.wrapper))
      throw new Error(`${target.wrapper} is missing from the package`);
    try {
      renameSync(staging, target.cacheDir);
    } catch (error) {
      if (!isRuntimeComplete(target.cacheDir, target.wrapper)) throw error;
    }
    rmSync(tarball, { force: true });
    return { path: join(target.cacheDir, target.wrapper), source: 'download' };
  } catch (error) {
    throw new Error(
      `Could not download ${target.name}@${target.version}: ${describeWriteFailure(error)}`,
      { cause: error }
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function sharedDownload(target: RuntimePackage): Promise<CopilotRuntime> {
  const running = downloads.get(target.cacheDir);
  if (running) return running;
  const download = downloadRuntime(target).finally(() => downloads.delete(target.cacheDir));
  downloads.set(target.cacheDir, download);
  return download;
}

/** @public */
export const resolveRuntime = (
  superpipe<{ resolved: typeof resolved }>({ resolved })('resolve-copilot-runtime') as PipelineAPI
)
  .input(['env', 'host', 'version', 'cacheRoot', 'bundled'])
  .pipe(configuredRuntime, 'env', 'runtime')
  .pipe('!resolved', 'runtime')
  .pipe(copilotRuntimePackage, ['host', 'version', 'cacheRoot'], 'target')
  .pipe(localRuntime, ['target', 'bundled'], 'runtime')
  .pipe('!resolved', 'runtime')
  .pipe(sharedDownload, 'target', 'runtime')
  .endAsync('runtime') as (
  env: NodeJS.ProcessEnv,
  host: Host,
  version: string,
  cacheRoot: string,
  bundled: boolean
) => Promise<CopilotRuntime>;

export function resolveCopilotRuntime(
  env: NodeJS.ProcessEnv = process.env,
  waitMs?: number
): Promise<CopilotRuntime> {
  const runtime = resolveRuntime(
    env,
    { platform: process.platform, arch: process.arch, musl: isMusl() },
    daemonPackage.dependencies[SDK_PACKAGE],
    join(getDataDir(), 'sdk'),
    isBundledBinary()
  );
  return waitMs === undefined ? runtime : waitForDownload(runtime, waitMs, 'Copilot runtime');
}
