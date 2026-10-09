import daemonPackageJson from '../../package.json' with { type: 'json' };

export const UNKNOWN_VERSION = 'unknown';

interface PackageMetadata {
  version?: string;
  dependencies?: Record<string, string>;
}

export interface BuildMetadata {
  version: string;
  claudeSdkVersion: string;
}

function nonEmpty(value: string | undefined): string {
  return value && value.trim() ? value : UNKNOWN_VERSION;
}

export function readBuildMetadata(pkg: PackageMetadata): BuildMetadata {
  return {
    version: nonEmpty(pkg.version),
    claudeSdkVersion: nonEmpty(pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']),
  };
}

export const BUILD_METADATA: BuildMetadata = readBuildMetadata(daemonPackageJson);
