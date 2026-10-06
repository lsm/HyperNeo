import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const NEO_LOOKUP_COMMANDS = [
  'cd',
  'gh pr view',
  'gh pr list',
  'gh pr checks',
  'gh pr diff',
  'gh issue view',
  'gh issue list',
  'gh run view',
  'gh run list',
  'gh repo view',
  'git log',
  'git show',
  'git status',
  'git diff',
  'git blame',
];

const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config'];
const SECRET_FILES = [
  '.claude/.credentials.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude.json',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
];
const SECRET_NAMES = ['.env', '.env.*', '*.pem', '*.key'];
const UNSAFE_SHELL = /[<>`]|\$\(|--output\b/;
const ALWAYS_ALLOWED = new Set(['WebSearch', 'WebFetch', 'AskUserQuestion']);

export interface LookUpScope {
  home: string;
  dataDir: string;
  cwd: string;
}

export function neoSecretReadRules(scope: Pick<LookUpScope, 'dataDir'>): string[] {
  return [
    ...SECRET_DIRS.map((dir) => `~/${dir}/**`),
    ...SECRET_FILES.map((file) => `~/${file}`),
    ...SECRET_NAMES.map((name) => `~/**/${name}`),
    `/${scope.dataDir}/**`,
  ].map((path) => `Read(${path})`);
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function secretName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || /\.(pem|key)$/.test(name);
}

function resolvePath(raw: string, scope: LookUpScope): string {
  const expanded = raw === '~' ? scope.home : raw.replace(/^~(?=\/)/, scope.home);
  return resolve(scope.cwd, expanded);
}

export function isSecretPath(raw: string, scope: LookUpScope): boolean {
  const path = resolvePath(raw, scope);
  return (
    within(path, scope.dataDir) ||
    SECRET_DIRS.some((dir) => within(path, join(scope.home, dir))) ||
    SECRET_FILES.some((file) => path === join(scope.home, file)) ||
    secretName(basename(path))
  );
}

function tooBroad(raw: string, scope: LookUpScope): boolean {
  const path = resolvePath(raw, scope);
  return within(scope.home, path) || path === sep;
}

function staticPrefix(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  return cut < 0 ? pattern : pattern.slice(0, cut);
}

export function bashDenial(command: string, scope: LookUpScope): string | null {
  if (UNSAFE_SHELL.test(command)) return 'redirects, substitutions and --output are not allowed';
  const segments = command.split(/&&|\|\||;|\|/).map((segment) => segment.trim());
  const unknown = segments.find(
    (segment) =>
      !NEO_LOOKUP_COMMANDS.some((prefix) => segment === prefix || segment.startsWith(`${prefix} `))
  );
  if (unknown !== undefined) return `"${unknown}" is not a read-only look-up command`;
  const tokens = command.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ''));
  const secret = tokens
    .flatMap((token) => token.split(':'))
    .find(
      (part) =>
        part && (secretName(basename(part)) || (/^[/~]/.test(part) && isSecretPath(part, scope)))
    );
  return secret ? `"${secret}" may hold secrets` : null;
}

export function neoLookUpDenial(
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope
): string | null {
  if (ALWAYS_ALLOWED.has(tool) || tool.startsWith('mcp__')) return null;
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  if (tool === 'Read')
    return isSecretPath(text('file_path'), scope) ? 'that file may hold secrets' : null;
  if (tool === 'Grep' || tool === 'Glob') {
    const root = text('path') || scope.cwd;
    const pattern = staticPrefix(text('pattern'));
    if (isSecretPath(root, scope) || tooBroad(root, scope))
      return 'search inside a project folder, not home or a secrets folder';
    return tool === 'Glob' && pattern && isSecretPath(pattern, scope)
      ? 'that pattern points at secrets'
      : null;
  }
  if (tool === 'Bash') return bashDenial(text('command'), scope);
  return `${tool} is not a look-up tool`;
}

export function neoLookUpGuard(scope: Omit<LookUpScope, 'cwd'>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const pre = input as PreToolUseHookInput;
    const reason = neoLookUpDenial(
      pre.tool_name,
      (pre.tool_input ?? {}) as Record<string, unknown>,
      {
        ...scope,
        cwd: pre.cwd,
      }
    );
    return reason
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Neo look-ups are read-only: ${reason}.`,
          },
        }
      : {};
  };
}
