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

const SECRET_DIRS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.claude/projects',
];
const SECRET_FILES = [
  '.claude/.credentials.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude.json',
  '.git-credentials',
  '.bash_history',
  '.zsh_history',
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
const UNSAFE_SHELL = /[<>`$\n\r]|(?<!&)&(?!&)|--output\b/;
const CONTENT_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'md',
  'mdx',
  'txt',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'css',
  'scss',
  'html',
  'sql',
  'sh',
  'vue',
  'svelte',
];
const CONTENT_TYPES = [
  'ts',
  'js',
  'md',
  'markdown',
  'txt',
  'py',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'css',
  'html',
  'sql',
  'sh',
  'vue',
  'svelte',
];
const ALWAYS_ALLOWED = new Set(['WebSearch', 'WebFetch', 'AskUserQuestion']);

export interface LookUpScope {
  home: string;
  dataDir: string;
  cwd: string;
}

export function neoSecretReadRules(scope: Pick<LookUpScope, 'dataDir' | 'home'>): string[] {
  return [
    ...SECRET_DIRS.map((dir) => `~/${dir}/**`),
    ...SECRET_FILES.flatMap((file) => [`~/${file}`, `~/**/${file}`]),
    ...SECRET_NAMES.map((name) => `~/**/${name}`),
    dataDirRule(scope.dataDir, scope.home),
  ].map((path) => `Read(${path})`);
}

function dataDirRule(dataDir: string, home: string): string {
  const rel = relative(home, dataDir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel}/**` : `/${dataDir}/**`;
}

function contentGlobExtensions(glob: string): string[] | null {
  const match = /^(?:\*\*\/)?\*\.(?:\{([a-z0-9,]+)\}|([a-z0-9]+))$/.exec(glob);
  return match ? (match[1] ?? match[2]).split(',') : null;
}

function grepDenial(input: Record<string, unknown>): string | null {
  if (input.output_mode === 'files_with_matches' || input.output_mode === 'count') return null;
  const glob = typeof input.glob === 'string' ? input.glob : '';
  const type = typeof input.type === 'string' ? input.type : '';
  if (glob) {
    const extensions = contentGlobExtensions(glob);
    return extensions?.every((extension) => CONTENT_EXTENSIONS.includes(extension))
      ? null
      : 'show matching lines only for code and docs, with a glob like *.ts or *.{ts,md}';
  }
  return CONTENT_TYPES.includes(type)
    ? null
    : 'show matching lines only for code and docs, with a glob like *.ts or a type like ts';
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function secretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx|tfstate|tfvars)$/.test(lower) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower) ||
    ['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.htpasswd', '.pgpass'].includes(lower) ||
    /(secret|credential|service-?account|token)[^.]*(\.(json|ya?ml|ini|conf|cfg|toml|txt|xml|properties))?$/.test(
      lower
    )
  );
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
    SECRET_FILES.some(
      (file) => path === join(scope.home, file) || path.endsWith(`${sep}${file}`)
    ) ||
    secretName(basename(path))
  );
}

function tooBroad(raw: string, scope: LookUpScope): boolean {
  const path = resolvePath(raw, scope);
  return within(scope.home, path) || path === sep;
}

function patternNamesSecret(pattern: string): boolean {
  return pattern
    .split('/')
    .some(
      (segment) => secretName(staticPrefix(segment)) || secretName(segment.replace(/[*?]/g, ''))
    );
}

function staticPrefix(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  return cut < 0 ? pattern : pattern.slice(0, cut);
}

export function bashDenial(command: string, scope: LookUpScope): string | null {
  if (UNSAFE_SHELL.test(command))
    return 'redirects, variables, substitutions, background jobs, line breaks and --output are not allowed';
  if (/[*?[\]{}]/.test(command.replace(/'[^']*'|"[^"]*"/g, '')))
    return 'unquoted wildcards are not allowed';
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
    if (tool === 'Grep') return grepDenial(input);
    return patternNamesSecret(text('pattern')) ||
      (pattern && isSecretPath(pattern, { ...scope, cwd: resolvePath(root, scope) }))
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
