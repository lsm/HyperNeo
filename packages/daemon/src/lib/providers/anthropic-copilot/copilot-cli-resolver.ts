import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COPILOT_PACKAGE = '@github/copilot';
const COPILOT_SDK_PACKAGE = '@github/copilot-sdk';

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  for (const libDir of ['/lib', '/lib64']) {
    try {
      const files = readdirSync(libDir);
      if (files.some((f) => f.startsWith('ld-musl'))) return true;
    } catch {}
  }
  return false;
}

export function getCopilotPlatformPackageName(): string | undefined {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return `${COPILOT_PACKAGE}-win32-x64`;
  if (platform === 'win32' && arch === 'arm64') return `${COPILOT_PACKAGE}-win32-arm64`;
  if (platform === 'darwin' && arch === 'x64') return `${COPILOT_PACKAGE}-darwin-x64`;
  if (platform === 'darwin' && arch === 'arm64') return `${COPILOT_PACKAGE}-darwin-arm64`;
  if (platform === 'linux' && arch === 'x64')
    return isMusl() ? `${COPILOT_PACKAGE}-linuxmusl-x64` : `${COPILOT_PACKAGE}-linux-x64`;
  if (platform === 'linux' && arch === 'arm64')
    return isMusl() ? `${COPILOT_PACKAGE}-linuxmusl-arm64` : `${COPILOT_PACKAGE}-linux-arm64`;
  return undefined;
}

export function getCopilotCliBinaryName(): string {
  return process.platform === 'win32' ? 'copilot.exe' : 'copilot';
}

let cachedCopilotCliPath: string | undefined;

function resolveFromNodeModules(): string | undefined {
  const binaryName = getCopilotCliBinaryName();
  const platformPkg = getCopilotPlatformPackageName();
  if (!platformPkg) return undefined;

  try {
    const resolved = import.meta.resolve?.(platformPkg);
    if (resolved) {
      const pkgPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
      const binPath = join(dirname(pkgPath), binaryName);
      if (existsSync(binPath)) return binPath;
    }
  } catch {}

  try {
    const sdkUrl = import.meta.resolve?.(COPILOT_SDK_PACKAGE);
    if (sdkUrl) {
      const sdkPath = sdkUrl.startsWith('file://') ? fileURLToPath(sdkUrl) : sdkUrl;
      const sdkReq = createRequire(sdkPath);
      const searchPaths =
        sdkReq.resolve.paths?.(platformPkg) ?? sdkReq.resolve.paths?.(COPILOT_PACKAGE) ?? [];
      for (const base of searchPaths) {
        const candidate = join(base, ...platformPkg.split('/'), binaryName);
        if (existsSync(candidate)) return candidate;
        const nested = join(
          base,
          '@github',
          'copilot',
          'node_modules',
          ...platformPkg.split('/'),
          binaryName
        );
        if (existsSync(nested)) return nested;
      }
    }
  } catch {}

  try {
    const copilotUrl =
      import.meta.resolve?.(`${COPILOT_PACKAGE}/sdk`) ?? import.meta.resolve?.(COPILOT_PACKAGE);
    if (copilotUrl) {
      const copilotPath = copilotUrl.startsWith('file://') ? fileURLToPath(copilotUrl) : copilotUrl;
      const copilotReq = createRequire(copilotPath);
      const searchPaths = copilotReq.resolve.paths?.(platformPkg) ?? [];
      for (const base of searchPaths) {
        const candidate = join(base, ...platformPkg.split('/'), binaryName);
        if (existsSync(candidate)) return candidate;
      }
      const bunDir = dirname(dirname(dirname(dirname(dirname(copilotPath)))));
      const hoistedPath = join(bunDir, 'node_modules', platformPkg, binaryName);
      if (existsSync(hoistedPath)) return hoistedPath;
    }
  } catch {}

  const startDirs = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const startDir of startDirs) {
    let currentDir = startDir;
    for (let i = 0; i < 10; i++) {
      const candidate = join(currentDir, 'node_modules', platformPkg, binaryName);
      if (existsSync(candidate)) return candidate;
      const bunCandidate = join(
        currentDir,
        'node_modules',
        '.bun',
        'node_modules',
        platformPkg,
        binaryName
      );
      if (existsSync(bunCandidate)) return bunCandidate;
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  }

  return undefined;
}

export function _resetForTesting(): void {
  cachedCopilotCliPath = undefined;
}

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

  if (cachedCopilotCliPath === '') return undefined;
  if (cachedCopilotCliPath !== undefined) return cachedCopilotCliPath;

  const nodeModulesPath = resolveFromNodeModules();
  if (nodeModulesPath) {
    cachedCopilotCliPath = nodeModulesPath;
    return cachedCopilotCliPath;
  }

  cachedCopilotCliPath = '';
  return undefined;
}
