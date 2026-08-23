import { createHash } from 'node:crypto';
import { parseAcpCommandWithSpans } from '@hyperneo/shared/acp';

export { getAcpCommandIdentity, parseAcpCommand } from '@hyperneo/shared/acp';

const SECRET_ARG_NAME_PATTERN =
  /(?:^|[-_])(?:token|secret|password|passphrase|credential|api[-_]?key|bearer)$/i;

const SECRET_HEADER_NAME_PATTERN =
  /(?:^|[-_])(?:authorization|auth|cookie|session|token|secret|password|credential|api[-_]?key|bearer)$/i;

const CURL_COMMAND_NAMES = new Set(['curl']);
const CURL_VALUE_TAKING_SHORT = new Set([
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'k',
  'm',
  'o',
  'p',
  'q',
  'r',
  't',
  'w',
  'x',
  'y',
  'z',
]);
const ENV_COMMAND_NAMES = new Set(['env', 'export']);

function commandBaseName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.exe$/i, '').toLowerCase();
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
  return /^u$/i.test(stripped) || /^user$/i.test(stripped) || /^proxy-user$/i.test(stripped);
}

function isSecretEnvAssignment(arg: string): boolean {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex <= 0) return false;
  return isSecretArgName(arg.slice(0, equalsIndex));
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

const URL_USERINFO_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:/@\s]*:)([^@/\s]+)(@.+)$/;

function redactUrlUserinfo(value: string): string {
  const match = URL_USERINFO_PATTERN.exec(value);
  return match ? `${match[1]}[redacted]${match[3]}` : value;
}

export function redactCommandSecrets(command: string, args: string[]): string[] {
  const isEnv = ENV_COMMAND_NAMES.has(commandBaseName(command));
  const assignmentsAllowed = isEnv;
  let inLeadingAssignments = true;
  let currentCommand = command;
  let awaitingCommandWord = isEnv;
  let endOfOptions = false;
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      endOfOptions = true;
      redacted.push(arg);
      continue;
    }
    if (endOfOptions) {
      redacted.push(redactUrlUserinfo(arg));
      continue;
    }
    if (!arg.startsWith('-')) {
      const looksLikeUrl = /^[a-z][a-z0-9+.-]*:/i.test(arg);
      const isAssignmentShaped = arg.indexOf('=') > 0;
      if (inLeadingAssignments && assignmentsAllowed && isSecretEnvAssignment(arg)) {
        redacted.push(`${arg.slice(0, arg.indexOf('='))}=[redacted]`);
      } else {
        if (!isAssignmentShaped) {
          inLeadingAssignments = false;
          if (awaitingCommandWord) {
            currentCommand = arg;
            awaitingCommandWord = false;
          }
        }
        if (isAssignmentShaped && !looksLikeUrl) {
          const at = arg.indexOf('=');
          const value = arg.slice(at + 1);
          const redactedValue = redactUrlUserinfo(value);
          redacted.push(redactedValue === value ? arg : `${arg.slice(0, at + 1)}${redactedValue}`);
        } else {
          redacted.push(redactUrlUserinfo(arg));
        }
      }
      continue;
    }
    const tokenCommandName = commandBaseName(currentCommand);
    const tokenCurl = CURL_COMMAND_NAMES.has(tokenCommandName);
    if (tokenCurl && /^-[a-z]*$/i.test(arg)) {
      const letters = arg.slice(1).toLowerCase();
      const valueFlag = letters.charAt(letters.length - 1);
      let clusterCarriesValue = false;
      for (let scan = 0; scan < letters.length - 1; scan++) {
        const ch = letters[scan];
        if (ch === 'h' || ch === 'u') break;
        if (CURL_VALUE_TAKING_SHORT.has(ch)) {
          clusterCarriesValue = true;
          break;
        }
      }
      const next = args[index + 1];
      if (
        !clusterCarriesValue &&
        (valueFlag === 'h' || valueFlag === 'u') &&
        next !== undefined &&
        (valueFlag === 'u' || !next.startsWith('--'))
      ) {
        if (valueFlag === 'u' || isSecretHeaderValue(next)) {
          redacted.push(arg, '[redacted]');
          index++;
          continue;
        }
      }
      redacted.push(arg);
      continue;
    }
    if (tokenCurl && /^-[a-z]*[hu]/i.test(arg)) {
      const lowered = arg.toLowerCase();
      let carrierIndex = -1;
      for (let scan = 1; scan < lowered.length; scan++) {
        const ch = lowered[scan];
        if (ch === 'h' || ch === 'u') {
          carrierIndex = scan;
          break;
        }
        if (!/[a-z]/i.test(ch)) break;
        if (CURL_VALUE_TAKING_SHORT.has(ch)) break;
      }
      if (carrierIndex > 0) {
        const value = arg.slice(carrierIndex + 1);
        const secret = lowered[carrierIndex] === 'u' || isSecretHeaderValue(value);
        if (secret && value) {
          redacted.push(`${arg.slice(0, carrierIndex + 1)}[redacted]`);
          continue;
        }
      }
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex >= 0) {
      const name = arg.slice(0, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      if (isSecretArgName(name)) {
        redacted.push(`${name}=[redacted]`);
      } else if (tokenCurl && isHeaderArgName(name) && isSecretHeaderValue(value)) {
        redacted.push(`${name}=[redacted]`);
      } else if (tokenCurl && isUserArgName(name)) {
        redacted.push(`${name}=[redacted]`);
      } else {
        const redactedValue = redactUrlUserinfo(value);
        redacted.push(redactedValue === value ? arg : `${name}=${redactedValue}`);
      }
      continue;
    }
    const next = args[index + 1];
    if (isSecretArgName(arg) && next !== undefined && !next.startsWith('--')) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    if (tokenCurl && isHeaderArgName(arg) && next !== undefined && isSecretHeaderValue(next)) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    if (tokenCurl && isUserArgName(arg) && next !== undefined) {
      redacted.push(arg, '[redacted]');
      index++;
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

export function getAcpCommandIdentityDigest(commandLine: string): string {
  const { command, args } = parseAcpCommandWithSpans(commandLine);
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
