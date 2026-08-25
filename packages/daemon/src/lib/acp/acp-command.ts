import { createHash } from 'node:crypto';
import { getAcpCommandIdentity } from '@hyperneo/shared/acp';
import { buildCommandEnv, envValue, STARTUP_ENV_BASELINE } from '../spawn-env.ts';

export { getAcpCommandIdentity, parseAcpCommand } from '@hyperneo/shared/acp';

export function getAcpCommandIdentityDigest(commandLine: string): string {
  return createHash('sha256').update(getAcpCommandIdentity(commandLine)).digest('hex');
}

const ACP_SAFE_ENV_KEYS = [
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SystemDrive',
  'PATHEXT',
  'COMSPEC',
] as const;

export function buildAcpSafeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    ACP_SAFE_ENV_KEYS.flatMap((key) => {
      const value = envValue(env, key);
      return value === undefined ? [] : [[key, value]];
    })
  );
}

export type AcpCredentialEnvBaseline = Readonly<Record<string, string>>;

const ACP_ENV_KEYS_VAR = 'HYPERNEO_ACP_ENV_KEYS';

export function getAcpCredentialEnvBaseline(): AcpCredentialEnvBaseline {
  const baseline: Record<string, string> = {};
  const configured = envValue(STARTUP_ENV_BASELINE, ACP_ENV_KEYS_VAR);
  if (!configured) return baseline;
  for (const entry of configured.split(',')) {
    const key = entry.trim();
    if (!key || key in baseline) continue;
    const value = envValue(STARTUP_ENV_BASELINE, key);
    if (value !== undefined) baseline[key] = value;
  }
  return baseline;
}

function definedEnvEntries(
  baseline: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseline)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function buildAcpClientEnv(): Record<string, string> {
  return {
    ...buildAcpSafeEnv(),
    ...buildCommandEnv(),
    ...definedEnvEntries(getAcpCredentialEnvBaseline()),
  };
}
