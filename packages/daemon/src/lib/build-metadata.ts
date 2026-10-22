import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import daemonPackageJson from '../../package.json' with { type: 'json' };

export const UNKNOWN_VERSION = 'unknown';

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

interface PackageMetadata {
  version?: string;
  dependencies?: Record<string, string>;
}

export interface BuildMetadata {
  version: string;
  claudeSdkVersion: string;
  commit: string;
}

function nonEmpty(value: string | undefined): string {
  return value && value.trim() ? value : UNKNOWN_VERSION;
}

export function readBuildMetadata(pkg: PackageMetadata, commit?: string): BuildMetadata {
  return {
    version: nonEmpty(pkg.version),
    claudeSdkVersion: nonEmpty(pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']),
    commit: nonEmpty(commit),
  };
}

export function readBuildCommit(
  env: Record<string, string | undefined>,
  gitHead: () => string
): string | undefined {
  const fromEnv = env.HYPERNEO_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const head = gitHead().trim();
    return GIT_COMMIT_PATTERN.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

export function readReleaseBuildCommit(
  env: Record<string, string | undefined>,
  gitHead: () => string = sourceGitHead
): string | undefined {
  return readBuildCommit(
    { HYPERNEO_BUILD_COMMIT: env.GITHUB_SHA || env.HYPERNEO_BUILD_COMMIT },
    gitHead
  );
}

function sourceGitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export const BUILD_METADATA: BuildMetadata = readBuildMetadata(
  daemonPackageJson,
  readBuildCommit({ HYPERNEO_BUILD_COMMIT: process.env.HYPERNEO_BUILD_COMMIT }, sourceGitHead)
);
