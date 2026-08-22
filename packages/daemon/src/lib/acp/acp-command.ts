import { createHash } from 'node:crypto';
import { parseAcpCommand } from '@hyperneo/shared/acp';

export { getAcpCommandIdentity, parseAcpCommand } from '@hyperneo/shared/acp';

const SECRET_ARG_NAME_PATTERN =
  /(?:^|[-_])(?:token|secret|password|passphrase|credential|api[-_]?key|bearer|user)$/i;

const SECRET_HEADER_NAME_PATTERN =
  /(?:^|[-_])(?:authorization|auth|cookie|session|token|secret|password|credential|api[-_]?key|bearer)$/i;

const SHELL_COMMAND_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const CURL_COMMAND_NAMES = new Set(['curl']);
const ENV_COMMAND_NAMES = new Set(['env']);

function commandBaseName(command: string): string {
  return (command.split('/').pop() ?? command).toLowerCase();
}

function isSecretArgName(name: string): boolean {
  return SECRET_ARG_NAME_PATTERN.test(name.replace(/^-+/, ''));
}

function isSecretHeaderValue(value: string): boolean {
  const headerName = value.split(':', 1)[0]?.trim() ?? '';
  return SECRET_HEADER_NAME_PATTERN.test(headerName);
}

function isHeaderArgName(name: string): boolean {
  const stripped = name.replace(/^-+/, '');
  return /^H$/i.test(stripped) || /^header$/i.test(stripped);
}

function isUserArgName(name: string): boolean {
  const stripped = name.replace(/^-+/, '');
  return /^u$/i.test(stripped) || /^user$/i.test(stripped);
}

function isShellCommandArgName(name: string): boolean {
  const stripped = name.replace(/^-+/, '');
  return /^c$/i.test(stripped);
}

function isSecretEnvAssignment(arg: string): boolean {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex <= 0) return false;
  return isSecretArgName(arg.slice(0, equalsIndex));
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function displayQuote(token: string): string {
  if (!/\s/.test(token)) return token;
  if (/[$`&|;<>()*?]/.test(token)) return token;
  return shellQuote(token);
}

const URL_USERINFO_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:/@\s]+:)([^@/\s]+)(@.+)$/;

function redactUrlUserinfo(value: string): string {
  const match = URL_USERINFO_PATTERN.exec(value);
  return match ? `${match[1]}[redacted]${match[3]}` : value;
}

function redactShellCommand(script: string, depth: number): string {
  if (depth <= 0) return script;
  try {
    const { command, args } = parseAcpCommand(script);
    const redactedArgs = redactCommandSecrets(command, args, depth - 1);
    if (redactedArgs.length === args.length && redactedArgs.every((arg, i) => arg === args[i])) {
      return script;
    }
    return [command, ...redactedArgs].map(displayQuote).join(' ');
  } catch {
    return script;
  }
}

export function redactCommandSecrets(command: string, args: string[], depth = 3): string[] {
  const commandName = commandBaseName(command);
  const isShell = SHELL_COMMAND_NAMES.has(commandName);
  const isCurl = CURL_COMMAND_NAMES.has(commandName);
  const isEnv = ENV_COMMAND_NAMES.has(commandName);
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      if (isEnv && isSecretEnvAssignment(arg)) {
        redacted.push(`${arg.slice(0, arg.indexOf('='))}=[redacted]`);
      } else {
        redacted.push(redactUrlUserinfo(arg));
      }
      continue;
    }
    if (isCurl && /^-H./.test(arg)) {
      redacted.push(isSecretHeaderValue(arg.slice(2)) ? '-H[redacted]' : arg);
      continue;
    }
    if (isCurl && /^-u./.test(arg)) {
      redacted.push('-u[redacted]');
      continue;
    }
    if (isShell && /^-c./.test(arg)) {
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
    if (isCurl && isHeaderArgName(arg) && next !== undefined && isSecretHeaderValue(next)) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    if (isCurl && isUserArgName(arg) && next !== undefined && !next.startsWith('--')) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    if (isShell && isShellCommandArgName(arg) && next !== undefined) {
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
  const identity = JSON.stringify([command, ...redactCommandSecrets(command, args)]);
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
