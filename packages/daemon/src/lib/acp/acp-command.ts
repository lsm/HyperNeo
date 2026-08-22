import { createHash } from 'node:crypto';
import { parseAcpCommand } from '@hyperneo/shared/acp';

export { getAcpCommandIdentity, parseAcpCommand } from '@hyperneo/shared/acp';

const SECRET_ARG_NAME_PATTERN =
  /(?:^|[-_])(?:token|secret|password|passphrase|credential|api[-_]?key|bearer|header)$|^H$/i;

function isSecretArgName(name: string): boolean {
  return SECRET_ARG_NAME_PATTERN.test(name.replace(/^-+/, ''));
}

export function redactSecretArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      redacted.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex >= 0) {
      const name = arg.slice(0, equalsIndex);
      redacted.push(isSecretArgName(name) ? `${name}=[redacted]` : arg);
      continue;
    }
    const next = args[index + 1];
    if (isSecretArgName(arg) && next !== undefined) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

export function getAcpCommandIdentityDigest(commandLine: string): string {
  const { command, args } = parseAcpCommand(commandLine);
  const identity = JSON.stringify([command, ...redactSecretArgs(args)]);
  return createHash('sha256').update(identity).digest('hex');
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
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
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
    ACP_SAFE_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))
  );
}
