import { createHash } from 'node:crypto';
import { parseAcpCommand } from '@hyperneo/shared/acp';

export { getAcpCommandIdentity, parseAcpCommand } from '@hyperneo/shared/acp';

const SECRET_ARG_NAME_PATTERN =
  /(?:^|[-_])(?:token|secret|password|passphrase|credential|api[-_]?key|bearer)$/i;

const SECRET_HEADER_NAME_PATTERN =
  /(?:^|[-_])(?:authorization|auth|cookie|session|token|secret|password|credential|api[-_]?key|bearer)$/i;

function isSecretArgName(name: string): boolean {
  return SECRET_ARG_NAME_PATTERN.test(name.replace(/^-+/, ''));
}

function isSecretHeaderValue(value: string): boolean {
  const headerName = value.split(':', 1)[0]?.trim() ?? '';
  return SECRET_HEADER_NAME_PATTERN.test(headerName);
}

function isHeaderArgName(name: string): boolean {
  const stripped = name.replace(/^-+/, '');
  return /^(?:H|header)$/i.test(stripped);
}

function isShellCommandArgName(name: string): boolean {
  const stripped = name.replace(/^-+/, '');
  return /^c$/i.test(stripped);
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function redactShellCommand(script: string, depth: number): string {
  if (depth <= 0) return script;
  try {
    const { command, args } = parseAcpCommand(script);
    return [command, ...redactSecretArgs(args, depth - 1)].map(shellQuote).join(' ');
  } catch {
    return script;
  }
}

export function redactSecretArgs(args: string[], depth = 3): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      redacted.push(arg);
      continue;
    }
    if (/^-H./.test(arg)) {
      redacted.push(isSecretHeaderValue(arg.slice(2)) ? '-H[redacted]' : arg);
      continue;
    }
    if (/^-c./.test(arg)) {
      redacted.push(`-c${redactShellCommand(arg.slice(2), depth)}`);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex >= 0) {
      const name = arg.slice(0, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      if (isSecretArgName(name)) {
        redacted.push(`${name}=[redacted]`);
      } else if (isHeaderArgName(name) && isSecretHeaderValue(value)) {
        redacted.push(`${name}=[redacted]`);
      } else {
        redacted.push(arg);
      }
      continue;
    }
    const next = args[index + 1];
    if (isSecretArgName(arg) && next !== undefined && !next.startsWith('--')) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    if (isHeaderArgName(arg) && next !== undefined && isSecretHeaderValue(next)) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    if (isShellCommandArgName(arg) && next !== undefined) {
      redacted.push(arg, redactShellCommand(next, depth));
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
