import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';

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
  'Library',
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

interface LookUpScope {
  home: string;
  dataDir: string;
  cwd: string;
  own?: readonly string[];
  readHome?: boolean;
}

interface LookUpPathFacts {
  realPath(path: string): string;
  exists(path: string): boolean;
  readText?(path: string): string | null;
}

const SCRIPT_READ_LIMIT = 256 * 1024;

function readLookUpPathFacts(): LookUpPathFacts {
  const real = new Map<string, string>();
  const present = new Map<string, boolean>();
  return {
    realPath: (path) => {
      if (!real.has(path)) {
        try {
          real.set(path, realpathSync(path));
        } catch {
          let parent = dirname(path);
          const suffix = [basename(path)];
          while (parent !== dirname(parent) && !existsSync(parent)) {
            suffix.unshift(basename(parent));
            parent = dirname(parent);
          }
          try {
            real.set(path, join(realpathSync(parent), ...suffix));
          } catch {
            real.set(path, path);
          }
        }
      }
      return real.get(path)!;
    },
    exists: (path) => {
      if (!present.has(path)) present.set(path, existsSync(path));
      return present.get(path)!;
    },
    readText: (path) => {
      try {
        return statSync(path).size <= SCRIPT_READ_LIMIT ? readFileSync(path, 'utf8') : null;
      } catch {
        return null;
      }
    },
  };
}

export function neoSecretReadRules(): string[] {
  return [
    ...SECRET_DIRS.map((dir) => `~/${dir}/**`),
    ...SECRET_FILES.flatMap((file) => [`~/${file}`, `~/**/${file}`]),
    ...SECRET_NAMES.map((name) => `~/**/${name}`),
  ].map((path) => `Read(${path})`);
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

export function isSecretPath(
  raw: string,
  scope: LookUpScope,
  facts: LookUpPathFacts = readLookUpPathFacts()
): boolean {
  const literal = resolvePath(raw, scope);
  const own = (scope.own ?? []).flatMap((root) => [root, facts.realPath(root)]);
  return [literal, facts.realPath(literal)].some((path) => secretAt(path, { ...scope, own }));
}

function secretAt(path: string, scope: LookUpScope): boolean {
  return (
    (scope.readHome &&
      within(path, join(scope.dataDir, 'Neo')) &&
      relative(join(scope.dataDir, 'Neo'), path).split(sep).includes('.git')) ||
    (within(path, scope.dataDir) &&
      !(scope.own ?? []).some((root) => within(path, root)) &&
      !(
        scope.readHome &&
        within(path, join(scope.dataDir, 'Neo')) &&
        !within(path, join(scope.dataDir, 'Neo', '.git')) &&
        !within(path, join(scope.dataDir, 'Neo', '.coordinators'))
      )) ||
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

const SECRET_SAMPLES = [
  '.env',
  '.env.local',
  'server.pem',
  'deploy.key',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  'secrets.json',
  'credentials.yaml',
];

function globCouldMatchSecret(segment: string, samples = SECRET_SAMPLES): boolean {
  if (!/[*?[{]/.test(segment) || /^[*?]+$/.test(segment)) return false;
  const source = segment
    .replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\{([^}]*)\}/g, (_match, options: string) => `(${options.split(',').join('|')})`)
    .replace(/\*+/g, '.*')
    .replace(/\?/g, '.');
  try {
    const glob = new RegExp(`^${source}$`);
    return samples.some((name) => glob.test(name));
  } catch {
    return true;
  }
}

function patternNamesSecret(pattern: string): boolean {
  return pattern
    .split('/')
    .some(
      (segment) =>
        secretName(staticPrefix(segment)) ||
        secretName(segment.replace(/[*?]/g, '')) ||
        globCouldMatchSecret(segment)
    );
}

function staticPrefix(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  return cut < 0 ? pattern : pattern.slice(0, cut);
}

function shellSegments(command: string): string[] {
  const masked = command.replace(/'[^']*'|"[^"]*"/g, (quoted) => 'x'.repeat(quoted.length));
  const segments: string[] = [];
  let start = 0;
  for (const operator of masked.matchAll(/&&|\|\||;|\||&|\r?\n|\r/g)) {
    segments.push(command.slice(start, operator.index));
    start = (operator.index ?? 0) + operator[0].length;
  }
  return [...segments, command.slice(start)].map((segment) => segment.trim());
}

function shellWords(segment: string): string[] {
  return segment
    .replace(/'([^']*)'|"([^"]*)"/g, '$1$2')
    .split(/\s+/)
    .map((word) => word.replace(/\\(.)/g, '$1'))
    .filter(Boolean);
}

function argumentPaths(word: string): string[] {
  const flagValue = word.includes('=')
    ? word.slice(word.indexOf('=') + 1)
    : /^-[A-Za-z][@<.~/]/.test(word)
      ? word.slice(2)
      : '';
  const value = word.startsWith('-')
    ? /^[@<.~/]/.test(flagValue) || flagValue.includes('/')
      ? flagValue
      : ''
    : word;
  return value
    .split('=')
    .map((part) => part.replace(/^(?:\d?>>?|&>>?|[@<])+/, ''))
    .filter(Boolean);
}

function pathShaped(part: string): boolean {
  return /[/.~*?[{]/.test(part) || /^id_/.test(part);
}

function secretArgument(
  words: readonly string[],
  dir: string,
  scope: LookUpScope,
  facts: LookUpPathFacts
): string | null {
  const here = { ...scope, cwd: dir };
  return (
    words
      .flatMap(argumentPaths)
      .flatMap((word) => word.split(':'))
      .find(
        (part) =>
          part &&
          ((pathShaped(part) && (secretName(basename(part)) || patternNamesSecret(part))) ||
            (/^[/~]/.test(part) && isSecretPath(part, here, facts)) ||
            (facts.exists(resolvePath(part, here)) && isSecretPath(part, here, facts)))
      ) ?? null
  );
}

export const NEO_LOCAL_CHANGE_NUDGE =
  "In principle Neo doesn't change things: hand changes to a card. Read-only checks are fine.";

export type NeoToolVerdict =
  | { kind: 'allow' }
  | { kind: 'nudge' }
  | { kind: 'deny'; reason: string };

const GH_CHANGES: Record<string, ReadonlySet<string>> = {
  pr: new Set([
    'merge',
    'create',
    'close',
    'comment',
    'review',
    'edit',
    'ready',
    'reopen',
    'lock',
    'unlock',
  ]),
  issue: new Set([
    'create',
    'comment',
    'close',
    'edit',
    'reopen',
    'delete',
    'transfer',
    'lock',
    'unlock',
    'pin',
    'unpin',
  ]),
  release: new Set(['create', 'delete', 'edit', 'upload']),
  label: new Set(['create', 'delete', 'edit']),
  secret: new Set(['set', 'delete']),
  variable: new Set(['set', 'delete']),
  workflow: new Set(['run', 'enable', 'disable']),
  run: new Set(['rerun', 'cancel', 'delete']),
  repo: new Set(['create', 'delete', 'edit', 'rename', 'archive', 'fork']),
  gist: new Set(['create', 'edit', 'delete', 'clone']),
};
const GH_WHAT: Record<string, string> = {
  pr: 'changing a pull request',
  issue: 'changing an issue',
};
const SERVICE_VERBS: Record<string, ReadonlySet<string>> = {
  launchctl: new Set([
    'kickstart',
    'stop',
    'start',
    'bootout',
    'bootstrap',
    'load',
    'unload',
    'remove',
    'kill',
    'enable',
    'disable',
  ]),
  systemctl: new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'kill']),
};
const KILLERS = new Set(['kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt']);
const DEPLOY_SCRIPT = /(deploy|update|restart|release)[\w.-]*\.sh$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const INTERPRETERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'perl',
  'ruby',
  'osascript',
]);
const INLINE_FLAGS = new Set(['-e', '-c', '-p', '-E', '--eval', '--print', 'eval']);
const INLINE_SHARED =
  /\bgit\b[^\n;]*\bpush\b|\bgh\s+(pr|issue)\s+(merge|create|close|comment|review|edit)\b|\blaunchctl\s+(kickstart|stop|bootout|unload)\b|\bsystemctl\s+(restart|stop|start)\b/;
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

function gitVerb(words: readonly string[]): { verb: string | undefined; at: number; dir?: string } {
  let at = 1;
  let dir: string | undefined;
  while (at < words.length && words[at].startsWith('-')) {
    const option = words[at];
    if (GIT_VALUE_OPTIONS.has(option)) {
      if (option === '-C') dir = words[at + 1];
      at += 2;
    } else at += 1;
  }
  return { verb: words[at], at, dir };
}

function ghApiChange(args: string): boolean {
  const method = /(?:-X|--method)[\s=]*['"]?([A-Za-z]+)/.exec(args)?.[1];
  if (method) return method.toUpperCase() !== 'GET';
  if (!/(?:^|\s)(-f|-F|--field|--raw-field|--input)\b/.test(args)) return false;
  return !/(?:^|\s)['"]?graphql\b/.test(args) || /\bmutation\b/.test(args);
}

function inlineCode(words: readonly string[]): string | null {
  if (!INTERPRETERS.has(words[0])) return null;
  const flag = words.findIndex((word, index) => index > 0 && INLINE_FLAGS.has(word));
  return flag > 0 && words[flag + 1] ? words.slice(flag + 1).join(' ') : null;
}

const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname']);

function ghCommand(words: readonly string[]): string[] {
  const rest: string[] = [];
  for (let at = 1; at < words.length; at += 1) {
    if (GH_VALUE_OPTIONS.has(words[at])) at += 1;
    else if (!/^(-R|--repo=|--hostname=)/.test(words[at])) rest.push(words[at]);
  }
  return rest;
}

export function neoSharedStateAction(words: readonly string[]): string | null {
  const [name, sub] = words;
  if (name === 'git') return gitVerb(words).verb === 'push' ? 'git push' : null;
  if (name === 'gh') {
    const [command, act, ...args] = ghCommand(words);
    if (command === 'api')
      return ghApiChange([act, ...args].join(' ')) ? 'a gh api call that changes GitHub' : null;
    return GH_CHANGES[command]?.has(act) ? (GH_WHAT[command] ?? 'changing GitHub') : null;
  }
  if (SERVICE_VERBS[name]?.has(sub)) return 'starting or stopping a daemon or service';
  if (KILLERS.has(name)) return 'stopping a process';
  const code = inlineCode(words);
  return code && INLINE_SHARED.test(code) ? 'inline code that pushes, merges or restarts' : null;
}

const SHELLS = new Set(['bash', 'sh', 'zsh']);

const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

function makeRecipe(makefile: string, targets: readonly string[]): string {
  const lines = makefile.split('\n');
  const wanted = targets.length
    ? targets
    : [lines.find((line) => /^[A-Za-z0-9_.-]+:/.test(line))?.split(':')[0] ?? ''];
  const recipe: string[] = [];
  let taking = false;
  for (const line of lines) {
    const target = /^([A-Za-z0-9_.-]+):/.exec(line)?.[1];
    if (target) taking = wanted.includes(target);
    else if (taking && line.startsWith('\t')) recipe.push(line);
  }
  return recipe.join('\n');
}

function packageScript(manifest: string, name: string): string | null {
  try {
    const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts;
    return typeof scripts?.[name] === 'string' ? scripts[name] : null;
  } catch {
    return null;
  }
}

const RUNNER_DIR_OPTIONS: Record<string, readonly string[]> = {
  make: ['-C', '--directory'],
  npm: ['--prefix', '-C'],
  pnpm: ['-C', '--dir'],
  yarn: ['--cwd'],
  bun: ['--cwd'],
};
const RUNNER_VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '--makefile',
  '-j',
  '--jobs',
  '-l',
  '--filter',
  '-w',
  '--workspace',
]);

function runnerArgs(words: readonly string[]): { args: string[]; dir?: string; file?: string } {
  const dirOptions = RUNNER_DIR_OPTIONS[words[0]] ?? [];
  const args: string[] = [];
  let dir: string | undefined;
  let file: string | undefined;
  for (let at = 1; at < words.length; at += 1) {
    const word = words[at];
    const [flag, inline] = word.includes('=')
      ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]
      : [word, undefined];
    if (dirOptions.includes(flag) || RUNNER_VALUE_OPTIONS.has(flag)) {
      const value = inline ?? words[at + 1];
      if (inline === undefined) at += 1;
      if (dirOptions.includes(flag)) dir = value;
      else if (['-f', '--file', '--makefile'].includes(flag)) file = value;
      continue;
    }
    if (!word.startsWith('-')) args.push(word);
  }
  return { args, dir, file };
}

function scriptFile(
  words: readonly string[],
  dir: string,
  scope: LookUpScope,
  facts: LookUpPathFacts
): string | null {
  const parsed = runnerArgs(words);
  const base = parsed.dir ? resolvePath(parsed.dir, { ...scope, cwd: dir }) : dir;
  const read = (path: string) =>
    facts.readText?.(resolvePath(path, { ...scope, cwd: base })) ?? null;
  const [name] = words;
  const args = parsed.args;
  if (name === 'source' || name === '.') return args[0] ? read(args[0]) : null;
  if (name.includes('/')) return read(name);
  if (name === 'make') {
    const makefile = read(parsed.file ?? 'Makefile');
    return makefile
      ? makeRecipe(
          makefile,
          args.filter((word) => !word.includes('='))
        )
      : null;
  }
  if (PACKAGE_RUNNERS.has(name) && (args[0] === 'run' || (name !== 'bun' && args.length))) {
    const script = args[0] === 'run' ? args[1] : args[0];
    const manifest = script ? read('package.json') : null;
    const body = manifest ? packageScript(manifest, script) : null;
    if (body || name !== 'bun') return body;
  }
  if (SHELLS.has(name) ? shellCommandFlag(words) > 0 : !INTERPRETERS.has(name)) return null;
  if (INTERPRETERS.has(name) && words.some((word) => INLINE_FLAGS.has(word))) return null;
  const path = args.find((word) => word !== 'run');
  return path ? read(path) : null;
}

function codePaths(code: string): string[] {
  return (code.match(/[^\s'"`(),;{}[\]+]+/g) ?? []).filter(
    (token) =>
      token.includes('/') ||
      token.startsWith('.') ||
      token.startsWith('~') ||
      /^id_/.test(token) ||
      /\.(pem|key)$/.test(token)
  );
}

function substitutions(segment: string): string[] {
  return [
    ...[...segment.matchAll(/[$<>]\(([^()]*)\)/g)].map((match) => match[1]),
    ...[...segment.matchAll(/`([^`]*)`/g)].map((match) => match[1]),
  ];
}

const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '-C', '-S']),
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t']),
  doas: new Set(['-u', '-C']),
  command: new Set(),
  nohup: new Set(),
  time: new Set(['-o', '-f']),
  timeout: new Set(['-s', '-k']),
  exec: new Set(['-a']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E']),
  nice: new Set(['-n']),
  stdbuf: new Set(['-i', '-o', '-e']),
  caffeinate: new Set(['-t', '-w']),
  watch: new Set(['-n', '-d']),
};
const WRAPPER_NUMBER_ARG = new Set(['timeout']);
const DELETES = new Set(['rm', 'rmdir', 'unlink', 'shred']);
const LAST_TARGET = new Set(['cp', 'mv', 'ln', 'rsync', 'install']);
const ALL_TARGETS = new Set(['touch', 'mkdir', 'chmod', 'chown', 'truncate', 'tee']);
const GIT_DELETES = new Set(['rm', 'clean']);
const GIT_CHANGES = new Set([
  'add',
  'commit',
  'checkout',
  'reset',
  'stash',
  'switch',
  'restore',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'apply',
  'am',
  'mv',
  'pull',
  'tag',
  'branch',
  'worktree',
]);

type LocalChange = { delete: boolean; targets: string[] };

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!']);
const SHELL_HEADERS = new Set(['for', 'select', 'case', 'done', 'fi', 'esac', 'function', 'in']);

function commandWords(words: readonly string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    if (SHELL_KEYWORDS.has(word)) {
      at += 1;
      continue;
    }
    if (SHELL_HEADERS.has(word)) return [];
    const values = WRAPPER_VALUE_FLAGS[word];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at += 1;
      continue;
    }
    if (!values) break;
    at += 1;
    while (
      at < words.length &&
      (words[at].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]))
    )
      at += values.has(words[at]) ? 2 : 1;
    if (WRAPPER_NUMBER_ARG.has(word) && /^\d+(\.\d+)?[smhd]?$/.test(words[at] ?? '')) at += 1;
  }
  const command = words.slice(at);
  if (basename(command[0] ?? '') === 'git') command[0] = 'git';
  return command;
}

const GIT_LIST_FLAGS = new Set([
  '-l',
  '--list',
  '--show-current',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--format',
  '--sort',
  '-n',
]);

const GIT_REF_CHANGE_FLAGS: Record<string, ReadonlySet<string>> = {
  branch: new Set([
    '-d',
    '-D',
    '--delete',
    '-m',
    '-M',
    '--move',
    '-c',
    '-C',
    '--copy',
    '-f',
    '--force',
    '-u',
    '--set-upstream-to',
    '--unset-upstream',
    '--edit-description',
  ]),
  tag: new Set([
    '-a',
    '--annotate',
    '-s',
    '--sign',
    '-u',
    '-m',
    '-F',
    '-e',
    '-d',
    '--delete',
    '-f',
    '--force',
  ]),
};

function gitReadOnly(verb: string | undefined, rest: readonly string[]): boolean {
  if (rest.includes('--dry-run')) return true;
  if (rest.includes('-n') && ['add', 'clean', 'rm', 'mv'].includes(verb ?? '')) return true;
  const flags = rest.filter((word) => word.startsWith('-'));
  const names = rest.filter((word) => !word.startsWith('-'));
  if (verb === 'branch' || verb === 'tag') {
    const changing = GIT_REF_CHANGE_FLAGS[verb];
    if (flags.some((flag) => changing.has(flag.split('=')[0]))) return false;
    return !names.length || flags.some((flag) => GIT_LIST_FLAGS.has(flag.split('=')[0]));
  }
  if (verb === 'worktree') return names[0] === 'list';
  if (verb === 'stash') return names[0] === 'list' || names[0] === 'show';
  return false;
}

function gitChange(words: readonly string[], dir: string): LocalChange | null {
  const { verb, at, dir: inside } = gitVerb(words);
  if (gitReadOnly(verb, words.slice(at + 1))) return null;
  const where = inside ?? dir;
  const sub = words.slice(at + 1).find((word) => !word.startsWith('-'));
  const removes =
    (verb === 'worktree' && (sub === 'remove' || sub === 'prune')) ||
    (verb === 'stash' && (sub === 'clear' || sub === 'drop'));
  if (GIT_DELETES.has(verb ?? '') || removes) return { delete: true, targets: [where] };
  return GIT_CHANGES.has(verb ?? '') ? { delete: false, targets: [where] } : null;
}

function localChange(words: readonly string[], dir: string): LocalChange | null {
  const [name, ...rest] = words;
  const args = rest.filter((word) => !word.startsWith('-'));
  const targets = (paths: string[]) => (paths.length ? paths : [dir]);
  if (name === 'git') return gitChange(words, dir);
  if (name === 'dd') {
    const out = rest.find((word) => word.startsWith('of='));
    return out ? { delete: false, targets: [out.slice(3)] } : null;
  }
  if (name === 'sed' && rest.some((word) => /^(-i|--in-place)/.test(word)))
    return { delete: false, targets: targets(args.slice(1)) };
  if (
    name === 'find' &&
    rest.some(
      (word, index) =>
        word === '-delete' ||
        (['-exec', '-execdir', '-ok', '-okdir'].includes(word) &&
          DELETES.has(rest[index + 1] ?? ''))
    )
  )
    return { delete: true, targets: targets(args.slice(0, 1)) };
  if (name === 'rsync' && rest.some((word) => word.startsWith('--delete')))
    return { delete: true, targets: targets(args.slice(-1)) };
  if (DELETES.has(name)) return { delete: true, targets: targets(args) };
  if (LAST_TARGET.has(name)) return { delete: false, targets: targets(args.slice(-1)) };
  if (ALL_TARGETS.has(name)) return { delete: false, targets: targets(args) };
  return null;
}

function redirectTargets(segment: string): string[] {
  const masked = segment.replace(/'[^']*'|"[^"]*"/g, (quoted) => 'x'.repeat(quoted.length));
  return [...masked.matchAll(/(?:^|[^<>&\d])\d?(?:>>?|&>)\s*([^\s;&|]+)/g)]
    .map((match) =>
      segment
        .slice(match.index + match[0].length - match[1].length, match.index + match[0].length)
        .replace(/^(['"])(.*)\1$/, '$2')
    )
    .filter((target) => target && !target.startsWith('&'));
}

function ownPath(path: string, scope: LookUpScope, facts: LookUpPathFacts): boolean {
  if (path === '/dev/null' || path.startsWith('/dev/')) return true;
  const roots = (scope.own ?? []).flatMap((root) => [root, facts.realPath(root)]);
  return [path, facts.realPath(path)].some((candidate) =>
    roots.some((root) => within(candidate, root))
  );
}

function shellCommandFlag(words: readonly string[]): number {
  if (!SHELLS.has(words[0])) return -1;
  return words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
}

function nestedCommand(words: readonly string[]): string | null {
  const flag = shellCommandFlag(words);
  return flag > 0 && words[flag + 1] ? words.slice(flag + 1).join(' ') : null;
}

export interface NeoBashFacts {
  secret: string | null;
  sharedState: string | null;
  unchecked?: string | null;
  deletesOutside: boolean;
  changesOutside: boolean;
}

const UNKNOWN_DIR = '/unknown-folder-for-neo-guard';
const PIPE_TO_SHELL =
  /\|\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|env|exec|command)\s+)*(?:ba|z)?sh(?:\s+-[A-Za-z]+)*\s*(?:$|[;&|)\n])/;
const SSH_VALUE_FLAGS = new Set([
  '-p',
  '-i',
  '-l',
  '-o',
  '-F',
  '-J',
  '-L',
  '-R',
  '-D',
  '-b',
  '-c',
  '-E',
  '-e',
  '-m',
  '-O',
  '-Q',
  '-S',
  '-W',
  '-w',
  '-B',
  '-I',
]);

function sshRemote(words: readonly string[]): { host: string; command: string } | null {
  if (words[0] !== 'ssh') return null;
  let at = 1;
  while (at < words.length && words[at].startsWith('-'))
    at += SSH_VALUE_FLAGS.has(words[at]) ? 2 : 1;
  const remote = words.slice(at + 1);
  const host = (words[at] ?? '').replace(/^[^@]*@/, '');
  return remote.length ? { host, command: remote.join(' ') } : null;
}

function credentialDump(raw: readonly string[], words: readonly string[]): string | null {
  if (!words.length && raw.some((word) => /(?:^|\/)env$/.test(word))) return 'env';
  if (words[0] === 'printenv') return 'printenv';
  if (words[0] === 'set' && words.length === 1) return 'set';
  if (words[0] === 'export' && (words.length === 1 || words[1] === '-p')) return 'export';
  if (words[0] === 'declare' && words.some((word) => /^-[a-z]*x/.test(word))) return 'declare -x';
  if (words[0] === 'gh' && words.includes('auth')) {
    if (words.includes('token') || words.includes('--show-token') || words.includes('-t'))
      return 'gh auth token';
  }
  return null;
}

function groupWords(words: readonly string[]): string[] {
  const out = [...words];
  if (out.length) out[0] = out[0].replace(/^[({]+/, '');
  if (out.length) out[out.length - 1] = out[out.length - 1].replace(/[)}]+$/, '');
  return out.filter(Boolean);
}

function changeDir(target: string | undefined, dir: string, scope: LookUpScope): string {
  if (target && /[$`]/.test(target)) return UNKNOWN_DIR;
  return resolvePath(target ?? '~', { ...scope, cwd: dir });
}

function analyzeBash(
  command: string,
  scope: LookUpScope,
  facts: LookUpPathFacts,
  depth: number
): NeoBashFacts {
  const found: NeoBashFacts = {
    secret: null,
    sharedState: null,
    deletesOutside: false,
    changesOutside: false,
  };
  let dir = scope.cwd;
  const stack: string[] = [];
  if (
    PIPE_TO_SHELL.test(command.replace(/'[^']*'|"[^"]*"/g, (quoted) => 'x'.repeat(quoted.length)))
  )
    found.unchecked = 'piping text into a shell';
  for (const segment of shellSegments(command)) {
    const raw = groupWords(shellWords(segment));
    const words = commandWords(raw);
    found.secret ??= credentialDump(raw, words);
    if (!words.length) continue;
    if (words[0] === 'popd') {
      dir = stack.pop() ?? UNKNOWN_DIR;
      continue;
    }
    if (words[0] === 'cd' || words[0] === 'pushd') {
      if (words[0] === 'pushd') stack.push(dir);
      dir = changeDir(
        words.find((word, index) => index > 0 && !word.startsWith('-')),
        dir,
        scope
      );
      if (isSecretPath(dir, scope, facts)) found.secret ??= words[1] ?? '~';
      continue;
    }
    if (words[0] !== 'ssh') found.secret ??= secretArgument(words.slice(1), dir, scope, facts);
    found.secret ??=
      redirectTargets(segment).find((target) =>
        isSecretPath(target, { ...scope, cwd: dir }, facts)
      ) ?? null;
    if (/<</.test(segment) && (SHELLS.has(words[0]) || words[0] === 'ssh'))
      found.unchecked ??= 'feeding a heredoc to a shell';
    found.sharedState ??= neoSharedStateAction(words);
    const code = inlineCode(words) ?? scriptFile(words, dir, scope, facts);
    if (code) {
      found.secret ??= secretArgument(codePaths(code), dir, scope, facts);
      if (INLINE_SHARED.test(code)) found.sharedState ??= 'code that pushes, merges or restarts';
    }
    const remote = depth < 3 ? sshRemote(words) : null;
    if (words[0] === 'ssh' && !remote) found.unchecked ??= 'an ssh session without a command';
    const remoteShell = remote ? commandWords(shellWords(remote.command)) : [];
    if (
      SHELLS.has(remoteShell[0]) &&
      shellCommandFlag(remoteShell) < 0 &&
      !remoteShell.slice(1).some((word) => !word.startsWith('-'))
    )
      found.unchecked ??= 'piping text into a remote shell';
    if (remote) {
      const local = LOCAL_HOSTS.has(remote.host);
      const inner = analyzeBash(
        remote.command,
        { ...scope, cwd: UNKNOWN_DIR, own: [], ...(local ? {} : { dataDir: UNKNOWN_DIR }) },
        facts,
        depth + 1
      );
      const deploys = shellSegments(remote.command).some((part) =>
        DEPLOY_SCRIPT.test(commandWords(shellWords(part))[0] ?? '')
      );
      found.secret ??= inner.secret;
      found.sharedState ??=
        inner.sharedState ??
        (deploys ? 'running a deploy or update script on another machine' : null) ??
        (inner.deletesOutside ? 'deleting on another machine' : null);
      found.unchecked ??= inner.unchecked;
    }
    const nested = [
      nestedCommand(words),
      words[0] === 'eval' ? words.slice(1).join(' ') : null,
      ...substitutions(segment),
    ].filter((inner): inner is string => !!inner);
    for (const text of depth < 3 ? nested : []) {
      const inner = analyzeBash(text, { ...scope, cwd: dir }, facts, depth + 1);
      found.secret ??= inner.secret;
      found.sharedState ??= inner.sharedState;
      found.unchecked ??= inner.unchecked;
      found.deletesOutside ||= inner.deletesOutside;
      found.changesOutside ||= inner.changesOutside;
    }
    const here = { ...scope, cwd: dir };
    const outside = (target: string) => !ownPath(resolvePath(target, here), scope, facts);
    const change = localChange(words, dir);
    if (words[0] === 'git' && change)
      change.targets.push(
        ...raw.flatMap((word) =>
          /^GIT_(DIR|WORK_TREE)=/.test(word) ? [word.slice(word.indexOf('=') + 1)] : []
        )
      );
    found.secret ??= change?.targets.find((target) => isSecretPath(target, here, facts)) ?? null;
    if (
      words[0] === 'git' &&
      change?.targets.some((target) =>
        [resolvePath(target, here), facts.realPath(resolvePath(target, here))].some((path) =>
          within(path, join(scope.dataDir, 'Neo'))
        )
      )
    )
      found.sharedState ??= 'changing the Neo home repository';
    if (change?.delete && change.targets.some(outside)) found.deletesOutside = true;
    if (change?.targets.some(outside) || redirectTargets(segment).some(outside))
      found.changesOutside = true;
  }
  return found;
}

export function readNeoBashFacts(
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope,
  facts: LookUpPathFacts
): NeoBashFacts | null {
  return tool === 'Bash'
    ? analyzeBash(typeof input.command === 'string' ? input.command : '', scope, facts, 0)
    : null;
}

const NEO_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
type NeoDeny = { kind: 'deny'; reason: string };
type NeoGate = { value: { kind: 'allow' } } | { reason: NeoDeny };
const pass: NeoGate = { value: { kind: 'allow' } };
const deny = (reason: string): NeoGate => ({ reason: { kind: 'deny', reason } });

function readDenial(
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope,
  facts: LookUpPathFacts
): string | null {
  scope = { ...scope, readHome: true };
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  if (tool === 'Read')
    return isSecretPath(text('file_path'), scope, facts) ? 'that file may hold secrets' : null;
  const root = text('path') || scope.cwd;
  const pattern = staticPrefix(text('pattern'));
  if (isSecretPath(root, scope, facts) || tooBroad(root, scope))
    return 'search inside a project folder, not home or a secrets folder';
  if (
    within(resolvePath(root, scope), join(scope.dataDir, 'Neo')) &&
    text(tool === 'Grep' ? 'glob' : 'pattern')
      .split('/')
      .some(
        (part) =>
          ['.git', '.coordinators'].includes(part) ||
          globCouldMatchSecret(part, ['.git', '.coordinators'])
      )
  )
    return 'that pattern points at secrets';
  if (tool === 'Grep') return grepDenial(input);
  return patternNamesSecret(text('pattern')) ||
    (pattern && isSecretPath(pattern, { ...scope, cwd: resolvePath(root, scope) }, facts))
    ? 'that pattern points at secrets'
    : null;
}

function writePath(input: Record<string, unknown>): string | null {
  return (
    [input.file_path, input.notebook_path].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    ) ?? null
  );
}

export function requireNeoSecretsUntouched(
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope,
  facts: LookUpPathFacts,
  bash: NeoBashFacts | null
): NeoGate {
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const reason = readDenial(tool, input, scope, facts);
    return reason ? deny(reason) : pass;
  }
  const path = NEO_WRITE_TOOLS.has(tool) ? writePath(input) : null;
  if (path && isSecretPath(path, scope, facts)) return deny('that file may hold secrets');
  return bash?.secret ? deny(`"${bash.secret}" may hold secrets`) : pass;
}

export function requireNeoSharedStateUntouched(bash: NeoBashFacts | null): NeoGate {
  if (bash?.sharedState) return deny(`${bash.sharedState} changes shared state`);
  if (bash?.unchecked) return deny(`${bash.unchecked} can't be checked`);
  return bash?.deletesOutside
    ? deny('deleting outside your own folder changes shared files')
    : pass;
}

export function planNeoLocalChange(
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope,
  facts: LookUpPathFacts,
  bash: NeoBashFacts | null
): NeoToolVerdict {
  const path = NEO_WRITE_TOOLS.has(tool) ? writePath(input) : null;
  const outside = path ? !ownPath(resolvePath(path, scope), scope, facts) : !!bash?.changesOutside;
  return outside ? { kind: 'nudge' } : { kind: 'allow' };
}

const decideNeoToolPipeline = (superpipe({})('decide-neo-tool') as PipelineAPI)
  .input(['tool', 'input', 'scope', 'facts'])
  .pipe(readNeoBashFacts, ['tool', 'input', 'scope', 'facts'], 'bash')
  .pipe(requireNeoSharedStateUntouched, 'bash', 'result:verdict')
  .pipe(requireNeoSecretsUntouched, ['tool', 'input', 'scope', 'facts', 'bash'], 'result:verdict')
  .pipe(planNeoLocalChange, ['tool', 'input', 'scope', 'facts', 'bash'], 'verdict')
  .end('verdict') as (
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope,
  facts: LookUpPathFacts
) => NeoToolVerdict;

export function decideNeoTool(
  tool: string,
  input: Record<string, unknown>,
  scope: LookUpScope,
  facts: LookUpPathFacts = readLookUpPathFacts()
): NeoToolVerdict {
  return decideNeoToolPipeline(tool, input, scope, facts);
}

export function neoToolDenialText(reason: string): string {
  return reason.endsWith('may hold secrets') ||
    reason.startsWith('search ') ||
    reason.startsWith('show ') ||
    reason.startsWith('that ')
    ? `Neo can't do that: ${reason}.`
    : `Neo doesn't do this: ${reason}. Hand it to the card's session (continue its card or propose one); read-only checks are fine.`;
}

export function neoToolGuard(scope: Omit<LookUpScope, 'cwd'>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const pre = input as PreToolUseHookInput;
    const verdict = decideNeoTool(
      pre.tool_name,
      (pre.tool_input ?? {}) as Record<string, unknown>,
      { ...scope, cwd: pre.cwd }
    );
    if (verdict.kind === 'deny')
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: neoToolDenialText(verdict.reason),
        },
      };
    return verdict.kind === 'nudge'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            additionalContext: NEO_LOCAL_CHANGE_NUDGE,
          },
        }
      : {};
  };
}
