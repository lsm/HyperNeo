import { createHash } from 'node:crypto';
import { parseAcpCommandWithSpans } from '@hyperneo/shared/acp';

export { getAcpCommandIdentity, parseAcpCommand } from '@hyperneo/shared/acp';

const SECRET_ARG_NAME_PATTERN =
  /(?:^|[-_])(?:token|secret|password|passphrase|credential|api[-_]?key|bearer)$/i;

const SECRET_HEADER_NAME_PATTERN =
  /(?:^|[-_])(?:authorization|auth|cookie|session|token|secret|password|credential|api[-_]?key|bearer)$/i;

const SHELL_COMMAND_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
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
const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '&', '(', ')']);

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

function displayQuote(token: string): string {
  if (!/\s/.test(token)) return token;
  if (/[$`&|;<>()*?]/.test(token)) return token;
  return shellQuote(token);
}

const URL_USERINFO_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:/@\s]*:)([^@/\s]+)(@.+)$/;

function redactUrlUserinfo(value: string): string {
  const match = URL_USERINFO_PATTERN.exec(value);
  return match ? `${match[1]}[redacted]${match[3]}` : value;
}

const SCRIPT_SENSITIVITY_PATTERN =
  /(^|\s)--?[^\s'"]*(?:token|secret|password|passphrase|credential|api[-_]?key|bearer)|(^|\s)-[hu]\b|(^|\s)[A-Za-z_][\w-]*(?:token|secret|password|passphrase|credential|api[-_]?key|bearer)[\w-]*=|:\/\/[^:/@\s]*:[^@\s]+@/i;

function splitShellScriptSegments(script: string): string[] {
  const lines = script.split('\n');
  const segments: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    current.push(line);
    const trailing = /\\+$/.exec(line)?.[0]?.length ?? 0;
    if (trailing % 2 === 0) {
      segments.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) segments.push(current.join('\n'));
  return segments;
}

function redactShellCommandTokens(script: string, depth: number): string {
  try {
    const parsed = parseAcpCommandWithSpans(script);
    const tokens = [parsed.command, ...parsed.args];
    const redactedArgs = redactCommandSecrets(parsed.command, parsed.args, depth - 1, {
      shellScript: true,
    });
    const redactedCommand = isSecretEnvAssignment(parsed.command)
      ? `${parsed.command.slice(0, parsed.command.indexOf('='))}=[redacted]`
      : parsed.command;
    const redactedTokens = [redactedCommand, ...redactedArgs];
    let result = script;
    let changed = false;
    for (let index = redactedTokens.length - 1; index >= 0; index--) {
      if (redactedTokens[index] === tokens[index]) continue;
      const span = parsed.rawSpans[index];
      if (!span) {
        changed = false;
        break;
      }
      const rawText = result.slice(span.start, span.end);
      const at = rawText.indexOf(tokens[index]);
      if (at >= 0) {
        result =
          result.slice(0, span.start) +
          rawText.slice(0, at) +
          redactedTokens[index] +
          rawText.slice(at + tokens[index].length) +
          result.slice(span.end);
      } else {
        result = result.slice(0, span.start) + redactedTokens[index] + result.slice(span.end);
      }
      changed = true;
    }
    if (changed) return result;
    if (redactedTokens.some((token, index) => token !== tokens[index])) {
      return redactedTokens.map(displayQuote).join(' ');
    }
    return script;
  } catch {
    return SCRIPT_SENSITIVITY_PATTERN.test(script) ? '[redacted script]' : script;
  }
}

function redactShellCommand(script: string, depth: number): string {
  if (depth <= 0) {
    return SCRIPT_SENSITIVITY_PATTERN.test(script) ? '[redacted script]' : script;
  }
  if (script.includes('\n')) {
    return splitShellScriptSegments(script)
      .map((segment) => redactShellCommandTokens(segment, depth))
      .join('\n');
  }
  return redactShellCommandTokens(script, depth);
}

export function redactCommandSecrets(
  command: string,
  args: string[],
  depth = 3,
  options: { shellScript?: boolean } = {}
): string[] {
  const isEnv = ENV_COMMAND_NAMES.has(commandBaseName(command));
  const assignmentsAllowed = isEnv || options.shellScript === true;
  let inLeadingAssignments =
    options.shellScript === true ? command.indexOf('=') > 0 || isEnv : true;
  let currentCommand = command;
  let awaitingCommandWord = isEnv || (options.shellScript === true && command.indexOf('=') > 0);
  let endOfOptions = false;
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options.shellScript === true && (SHELL_OPERATORS.has(arg) || /[;&|]$/.test(arg))) {
      inLeadingAssignments = true;
      endOfOptions = false;
      awaitingCommandWord = true;
      const word = arg.replace(/[;&|]+$/, '');
      if (word && !SHELL_OPERATORS.has(word)) currentCommand = word;
      redacted.push(arg);
      continue;
    }
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
      if (options.shellScript === true && !looksLikeUrl && /[;&|]/.test(arg)) {
        inLeadingAssignments = true;
        endOfOptions = false;
        awaitingCommandWord = true;
        redacted.push(
          arg.replace(/(^|[;&|])([A-Za-z_][\w-]*)=([^;&|\s]*)/g, (whole, pre, name) =>
            isSecretEnvAssignment(`${name}=`) ? `${pre}${name}=[redacted]` : whole
          )
        );
        continue;
      }
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
    const tokenShell = SHELL_COMMAND_NAMES.has(tokenCommandName);
    if (tokenCurl && /^-[a-z]*$/i.test(arg)) {
      const letters = arg.slice(1).toLowerCase();
      const valueFlag = letters.charAt(letters.length - 1);
      const next = args[index + 1];
      if (
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
    if (tokenShell && /^-[a-z]*c[a-z]*$/i.test(arg)) {
      const next = args[index + 1];
      if (next !== undefined) {
        redacted.push(arg, redactShellCommand(next, depth));
        index++;
        continue;
      }
    }
    if (tokenShell && /^-[a-z]*c/i.test(arg)) {
      const cIndex = arg.toLowerCase().lastIndexOf('c');
      const attachedScript = arg.slice(cIndex + 1);
      if (attachedScript && !/[a-zA-Z]/.test(attachedScript)) {
        redacted.push(`${arg.slice(0, cIndex + 1)}${redactShellCommand(attachedScript, depth)}`);
        continue;
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
