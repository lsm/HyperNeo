import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COPILOT_PACKAGE = '@github/copilot';

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

  if (platformPkg) {
    try {
      const resolved = import.meta.resolve?.(platformPkg);
      if (resolved) {
        const pkgPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
        const binPath = join(dirname(pkgPath), binaryName);
        if (existsSync(binPath)) return binPath;
      }
    } catch {}
  }

  if (platformPkg) {
    try {
      const copilotModulePath = import.meta.resolve?.(COPILOT_PACKAGE);
      if (copilotModulePath) {
        const copilotPath = copilotModulePath.startsWith('file://')
          ? fileURLToPath(copilotModulePath)
          : copilotModulePath;
        const bunDir = dirname(dirname(dirname(dirname(dirname(copilotPath)))));
        const hoistedPath = join(bunDir, 'node_modules', platformPkg, binaryName);
        if (existsSync(hoistedPath)) return hoistedPath;
      }
    } catch {}
  }

  if (platformPkg) {
    try {
      let currentDir = dirname(fileURLToPath(import.meta.url));
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
    } catch {}
  }

  return undefined;
}

export function _resetForTesting(): void {
  cachedCopilotCliPath = undefined;
}

export function resolveCopilotCliPath(): string | undefined {
  if (cachedCopilotCliPath === '') return undefined;
  if (cachedCopilotCliPath !== undefined) return cachedCopilotCliPath;

  const envPath = process.env.COPILOT_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    try {
      const stat = lstatSync(envPath);
      if (stat.isFile() && stat.size > 0) {
        cachedCopilotCliPath = envPath;
        return cachedCopilotCliPath;
      }
    } catch {}
  }

  const nodeModulesPath = resolveFromNodeModules();
  if (nodeModulesPath) {
    cachedCopilotCliPath = nodeModulesPath;
    return cachedCopilotCliPath;
  }

  cachedCopilotCliPath = '';
  return undefined;
}
