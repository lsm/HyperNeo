import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export { resolveLocalPipeline } from './pipeline-route-resolver.ts';

type Kind = 'op' | 'rpc' | 'event' | 'table';
type Role = 'defines' | 'uses' | 'handles' | 'calls' | 'emits' | 'listens' | 'reads' | 'writes';

export interface Link {
  kind: Kind;
  name: string;
  role: Role;
  path: string;
}

export interface PackageEntry {
  dir: string;
  exports: Record<string, string>;
  main: string;
}

export interface SystemMap {
  imports: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  links: Link[];
}

export interface Impact {
  path: string;
  known: boolean;
  importers: string[];
  owned: { link: Link; peers: Link[] }[];
  nearbyWrites: string[];
  nearbyEmits: string[];
}

interface Scan {
  imports: string[];
  literals: { value: string; context: string }[];
  sql: { verb: string; table: string }[];
  definesOperations: boolean;
}

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
const LITERAL = /(['"`])([a-zA-Z]\w*(?:\.[A-Za-z]\w*)*)\1/g;
const SQL =
  /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|FROM|JOIN|CREATE\s+(?:VIRTUAL\s+|TEMP\s+|TEMPORARY\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+([a-z_][a-z0-9_]{2,})\b/g;
const OPEN_CALL =
  /\(\s*(?:[\w.()]+\s*,\s*)?(?:(?:[^,;(){}?:'"`]|\([^(){};]*\))+\?\s*(?:(['"`])[\w.]+\1\s*:\s*)?)?$/;
const OWNING = new Set<Role>(['defines', 'handles', 'emits', 'writes']);
const RPC_CALLS = new Set(['request', 'callIfConnected']);
const EVENT_EMITS = new Set(['publish', 'event']);
const EVENT_LISTENS = new Set(['subscribe', 'onEvent']);

export function isSource(path: string): boolean {
  return (
    /^packages\/[^/]+\/src\/.+\.tsx?$/.test(path) &&
    !path.endsWith('.d.ts') &&
    !/\/(tests?|__tests__|__mocks__)\/|\.(test|spec)\./.test(path)
  );
}

function contextBefore(source: string, index: number): string {
  const start = Math.max(0, index - 160);
  const before = source.slice(start, index);
  if (/\bname:\s*$/.test(before)) return 'name:';
  const open = OPEN_CALL.exec(before);
  if (!open) return '';
  let at = start + open.index - 1;
  while (at >= 0 && /\s/.test(source[at])) at--;
  if (source[at] === '>') {
    if (source[at - 1] === '=') return '';
    const limit = Math.max(0, at - 600);
    let depth = 0;
    for (; at >= limit; at--) {
      if (source[at] === '>' && source[at - 1] !== '=') depth++;
      else if (source[at] === '<' && --depth === 0) break;
    }
    if (at < limit) return '';
    at--;
    while (at >= 0 && /\s/.test(source[at])) at--;
  }
  const end = at + 1;
  while (at >= 0 && /\w/.test(source[at])) at--;
  return source.slice(at + 1, end);
}

function scanFile(source: string): Scan {
  const literals: Scan['literals'] = [];
  for (const match of source.matchAll(LITERAL)) {
    literals.push({ value: match[2], context: contextBefore(source, match.index) });
  }
  return {
    imports: [...new Set([...source.matchAll(IMPORT)].map((match) => match[2]))],
    literals,
    sql: [...source.matchAll(SQL)].map((match) => ({
      verb: match[1].split(/\s+/)[0],
      table: match[2],
    })),
    definesOperations: source.includes('defineOperation('),
  };
}

function firstExisting(base: string, has: (path: string) => boolean): string | undefined {
  return [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/mod.ts`,
    `${base}/index.tsx`,
  ].find(has);
}

function packageTarget(entry: PackageEntry, subpath: string): string | undefined {
  if (entry.exports[subpath]) return entry.exports[subpath];
  for (const [pattern, target] of Object.entries(entry.exports)) {
    const [prefix, suffix] = pattern.split('*');
    if (suffix === undefined || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    return target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return subpath === '.' ? entry.main : undefined;
}

function resolveImport(
  from: string,
  specifier: string,
  has: (path: string) => boolean,
  packages: Map<string, PackageEntry>
): string | undefined {
  if (specifier.startsWith('.'))
    return firstExisting(normalize(join(dirname(from), specifier)), has);
  for (const [name, entry] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = `.${specifier.slice(name.length)}`;
    const target = packageTarget(entry, subpath);
    return (
      (target && firstExisting(normalize(join(entry.dir, target)), has)) ??
      firstExisting(normalize(join(entry.dir, 'src', subpath)), has)
    );
  }
  return undefined;
}

function roleOf(kind: Kind, context: string, definesOperations: boolean): Role | undefined {
  if (kind === 'op') return context === 'name:' && definesOperations ? 'defines' : 'uses';
  if (kind === 'rpc') {
    return context === 'onRequest' ? 'handles' : RPC_CALLS.has(context) ? 'calls' : undefined;
  }
  return EVENT_EMITS.has(context) ? 'emits' : EVENT_LISTENS.has(context) ? 'listens' : undefined;
}

export function buildSystemMap(
  sources: Map<string, string>,
  packages: Map<string, PackageEntry> = new Map()
): SystemMap {
  const scans = new Map([...sources].map(([path, source]) => [path, scanFile(source)]));
  const names: Record<Kind, Set<string>> = {
    op: new Set(),
    rpc: new Set(),
    event: new Set(),
    table: new Set(),
  };
  const isNameList = (path: string) => path.includes('/types/operation-names');
  for (const [path, scan] of scans) {
    for (const { verb, table } of scan.sql) if (verb === 'CREATE') names.table.add(table);
    for (const { value, context } of scan.literals) {
      if (isNameList(path)) names.op.add(value);
      if (!value.includes('.')) continue;
      if (context === 'onRequest') names.rpc.add(value);
      if (EVENT_EMITS.has(context)) names.event.add(value);
    }
  }
  const links = new Map<string, Link>();
  const add = (kind: Kind, name: string, role: Role | undefined, path: string) => {
    if (role) links.set(`${kind} ${name} ${role} ${path}`, { kind, name, role, path });
  };
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  for (const [path, scan] of scans) {
    const targets = new Set<string>();
    for (const specifier of scan.imports) {
      const target = resolveImport(path, specifier, (file) => sources.has(file), packages);
      if (!target || target === path) continue;
      targets.add(target);
      importers.set(target, (importers.get(target) ?? new Set()).add(path));
    }
    imports.set(path, targets);
    if (isNameList(path)) continue;
    for (const { value, context } of scan.literals) {
      for (const kind of ['op', 'rpc', 'event'] as const) {
        if (names[kind].has(value)) {
          add(kind, value, roleOf(kind, context, scan.definesOperations), path);
        }
      }
    }
    if (path.includes('/storage/schema/')) continue;
    for (const { verb, table } of scan.sql) {
      if (!names.table.has(table) || verb === 'CREATE') continue;
      add('table', table, verb === 'FROM' || verb === 'JOIN' ? 'reads' : 'writes', path);
    }
  }
  const order = (link: Link) => `${link.kind} ${link.name} ${link.role} ${link.path}`;
  return {
    imports,
    importers,
    links: [...links.values()].sort((a, b) => order(a).localeCompare(order(b))),
  };
}

export function where(map: SystemMap, name: string): Link[] {
  return map.links.filter((link) => link.name === name);
}

function nearby(map: SystemMap, start: string, hops: number): Set<string> {
  const reached = new Set([start]);
  let frontier = [start];
  for (let hop = 0; hop < hops; hop++) {
    frontier = frontier.flatMap((path) =>
      [...(map.imports.get(path) ?? [])].filter((target) => !reached.has(target))
    );
    for (const path of frontier) reached.add(path);
  }
  reached.delete(start);
  return reached;
}

export function impact(map: SystemMap, plan: readonly string[]): Impact[] {
  const planned = new Set(plan);
  return plan.map((path) => {
    const own = map.links.filter((link) => link.path === path);
    const owned = own
      .filter((link) => OWNING.has(link.role))
      .map((link) => ({
        link,
        peers: map.links.filter(
          (peer) => peer.kind === link.kind && peer.name === link.name && !planned.has(peer.path)
        ),
      }));
    const ownNames = new Set(own.map((link) => link.name));
    const around = nearby(map, path, 2);
    const namesNearby = (role: Role) => [
      ...new Set(
        map.links
          .filter((link) => link.role === role && around.has(link.path) && !ownNames.has(link.name))
          .map((link) => link.name)
      ),
    ];
    return {
      path,
      known: map.imports.has(path),
      importers: [...(map.importers.get(path) ?? [])].filter((file) => !planned.has(file)).sort(),
      owned,
      nearbyWrites: namesNearby('writes'),
      nearbyEmits: namesNearby('emits'),
    };
  });
}

function area(path: string): string {
  const parts = path.split('/');
  const dirs = parts.slice(3, -1);
  return [parts[1], ...dirs.slice(0, dirs[0] === 'lib' ? 2 : 1)].join('/');
}

export function formatWhere(links: readonly Link[]): string {
  return links.map((link) => `${link.kind} ${link.name}  ${link.role}  ${link.path}`).join('\n');
}

export function formatImpact(impacts: readonly Impact[]): string {
  const lines: string[] = [];
  const outside = new Set<string>();
  for (const item of impacts) {
    lines.push(item.known ? item.path : `${item.path}  (not a mapped source file)`);
    if (item.importers.length) {
      const areas = new Map<string, number>();
      for (const file of item.importers) areas.set(area(file), (areas.get(area(file)) ?? 0) + 1);
      const summary = [...areas].map(([name, count]) => `${name} ${count}`).join(', ');
      lines.push(`  imported by ${item.importers.length} files outside the plan: ${summary}`);
    }
    for (const { link, peers } of item.owned) {
      lines.push(`  ${link.role} ${link.kind} ${link.name}`);
      for (const peer of peers) {
        lines.push(`    ${peer.role}  ${peer.path}`);
        outside.add(peer.path);
      }
    }
    if (item.nearbyWrites.length) {
      lines.push(`  tables written within two imports: ${item.nearbyWrites.join(', ')}`);
    }
    if (item.nearbyEmits.length) {
      lines.push(`  events emitted within two imports: ${item.nearbyEmits.join(', ')}`);
    }
  }
  lines.push(`${outside.size} files outside the plan are linked by name`);
  return lines.join('\n');
}

function git(root: string, ...args: string[]): string[] {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().split('\n').filter(Boolean);
}

export function readRepositorySources(root: string, includeUntracked = false): Map<string, string> {
  const options = includeUntracked ? ['--cached', '--others', '--exclude-standard'] : [];
  return new Map(
    git(root, 'ls-files', ...options, '--', 'packages')
      .filter((path) => isSource(path) && existsSync(join(root, path)))
      .map((path) => [path, readFileSync(join(root, path), 'utf8')])
  );
}

function loadRepository(root: string): SystemMap {
  const sources = readRepositorySources(root);
  const packages = new Map<string, PackageEntry>();
  for (const name of readdirSync(join(root, 'packages'))) {
    const file = join(root, 'packages', name, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const exports = Object.entries(typeof manifest.exports === 'object' ? manifest.exports : {});
    packages.set(manifest.name, {
      dir: `packages/${name}`,
      exports: Object.fromEntries(exports.filter(([, target]) => typeof target === 'string')),
      main: manifest.main ?? 'src/index.ts',
    });
  }
  return buildSystemMap(sources, packages);
}

interface PipelineDescription {
  name: string;
  inputs: unknown;
  steps: { name: string; input?: unknown; output?: unknown }[];
  output?: unknown;
}

async function describeRunner(path: string, name: string): Promise<PipelineDescription> {
  const module = await import(pathToFileURL(resolve(path)).href);
  const runner = module[name];
  const pipeline = runner?.pipeline;
  if (typeof runner !== 'function' || !pipeline || !Array.isArray(pipeline.steps)) {
    throw new Error(`export ${name} is not a built pipeline runner`);
  }
  return pipeline;
}

function formatRoute(pipeline: PipelineDescription): string {
  const lines = [`${pipeline.name}  inputs: ${JSON.stringify(pipeline.inputs)}`];
  for (const step of pipeline.steps) {
    lines.push(
      `  ${step.name}  inputs: ${JSON.stringify(step.input ?? null)}  outputs: ${JSON.stringify(step.output ?? null)}`
    );
  }
  lines.push(`  output: ${JSON.stringify(pipeline.output ?? null)}`);
  return lines.join('\n');
}

async function listRoutes(root: string): Promise<void> {
  let describable = 0;
  let unavailable = 0;
  for (const path of git(root, 'ls-files', '--', 'packages').filter(isSource)) {
    if (!existsSync(join(root, path))) continue;
    const source = readFileSync(join(root, path), 'utf8');
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const exports: string[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'superpipe'
      ) {
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isVariableDeclaration(parent) && !ts.isStatement(parent))
          parent = parent.parent;
        const declaration = parent && ts.isVariableDeclaration(parent) ? parent : undefined;
        const statement = declaration?.parent.parent;
        if (
          declaration &&
          ts.isIdentifier(declaration.name) &&
          statement &&
          ts.isVariableStatement(statement) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          exports.push(declaration.name.text);
        } else {
          unavailable++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    for (const name of exports) {
      try {
        const description = await describeRunner(join(root, path), name);
        console.log(`${path} ${name}  ${description.name}`);
        describable++;
      } catch {
        unavailable++;
      }
    }
  }
  console.log(`${describable} describable, ${unavailable} not describable (source scan)`);
}

const USAGE = `Usage:
  bun run system-map routes <module> <export>  describe an exported runner
  bun run system-map routes list               list discoverable runners
  bun run system-map where <name>            who defines, calls, reads or writes an operation,
                                             RPC method, event or table
  bun run system-map impact <file>...        what the planned files are linked to outside the plan
  bun run system-map impact --diff [base]    the same for files changed since base (origin/dev)`;

async function main(args: readonly string[]): Promise<number> {
  const root = process.cwd();
  const [command, ...rest] = args;
  if (command === 'routes' && rest.length === 1 && rest[0] === 'list') {
    await listRoutes(root);
    return 0;
  }
  if (command === 'routes' && rest.length === 2) {
    try {
      console.log(formatRoute(await describeRunner(rest[0], rest[1])));
      return 0;
    } catch (error) {
      console.error(`not describable: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === 'where' && rest.length === 1) {
    const links = where(loadRepository(root), rest[0]);
    console.log(links.length ? formatWhere(links) : `No links found for ${rest[0]}`);
    return links.length ? 0 : 1;
  }
  if (command === 'impact' && rest.length) {
    const plan =
      rest[0] === '--diff'
        ? git(root, 'diff', '--name-only', '--merge-base', rest[1] ?? 'origin/dev').filter(isSource)
        : rest;
    console.log(formatImpact(impact(loadRepository(root), plan)));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

export interface PipelineCounts {
  missing: number;
  misnamed: number;
  dynamic: number;
  unreadable: number;
}

interface PipelineToken {
  text: string;
  offset: number;
}

function pipelineTokens(source: string): PipelineToken[] {
  const pattern =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`\\]*(?:\\.[^`\\]*)*`)|[A-Za-z_$][\w$]*|\d+|[^\s]/g;
  return [...source.matchAll(pattern)]
    .filter((match) => !match[0].startsWith('//') && !match[0].startsWith('/*'))
    .map((match) => ({ text: match[0], offset: match.index }));
}

function closeToken(tokens: PipelineToken[], start: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const pending: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (pairs[text]) pending.push(pairs[text]);
    else if (text === ')' || text === '}' || text === ']') {
      if (pending.pop() !== text) return -1;
      if (!pending.length) return i;
    }
  }
  return -1;
}

function stringToken(text: string | undefined): string | undefined {
  if (!text || !/^(['"])[\s\S]*\1$/.test(text)) return undefined;
  return text.slice(1, -1);
}

export function countPipelineRoutes(sources: Map<string, string>): PipelineCounts {
  const counts: PipelineCounts = { missing: 0, misnamed: 0, dynamic: 0, unreadable: 0 };
  for (const [file, source] of sources) {
    if (!isSource(file)) continue;
    const tokens = pipelineTokens(source);
    const scopes: number[][] = [];
    const scope: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      scopes.push([...scope]);
      if (tokens[i].text === '{') scope.push(i);
      else if (tokens[i].text === '}') scope.pop();
    }
    let bindingScopes: { name: string; start: number; end: number }[] | undefined;
    const bindingShadows = (reference: number, pipeline: number, name: string): boolean => {
      if (!bindingScopes) {
        bindingScopes = [];
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const add = (binding: ts.BindingName, scope: ts.Node) => {
          if (ts.isIdentifier(binding)) {
            bindingScopes!.push({ name: binding.text, start: scope.pos, end: scope.end });
          } else {
            for (const element of binding.elements) {
              if (ts.isBindingElement(element)) add(element.name, scope);
            }
          }
        };
        const declarationScope = (node: ts.VariableDeclaration): ts.Node | undefined => {
          if (ts.isCatchClause(node.parent)) return node.parent.block;
          if (!ts.isVariableDeclarationList(node.parent)) return undefined;
          const blockScoped = (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
          for (let scope: ts.Node | undefined = node.parent.parent; scope; scope = scope.parent) {
            if (ts.isSourceFile(scope) || ts.isModuleBlock(scope)) return scope;
            if (
              blockScoped &&
              (ts.isBlock(scope) ||
                ts.isCaseBlock(scope) ||
                ts.isForStatement(scope) ||
                ts.isForInStatement(scope) ||
                ts.isForOfStatement(scope))
            )
              return scope;
            if (!blockScoped && ts.isFunctionLike(scope)) {
              return (scope as ts.FunctionLikeDeclaration).body ?? scope;
            }
          }
          return undefined;
        };
        const visit = (node: ts.Node) => {
          if (ts.isFunctionLike(node)) {
            const fn = node as ts.FunctionLikeDeclaration;
            if (fn.body) {
              for (const parameter of fn.parameters) add(parameter.name, fn.body);
            }
          }
          if (ts.isVariableDeclaration(node)) {
            const scope = declarationScope(node);
            if (scope) add(node.name, scope);
          }
          if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
            let scope: ts.Node | undefined = node.parent;
            while (
              scope &&
              !ts.isBlock(scope) &&
              !ts.isCaseBlock(scope) &&
              !ts.isModuleBlock(scope) &&
              !ts.isSourceFile(scope)
            )
              scope = scope.parent;
            if (scope) add(node.name, scope);
          }
          ts.forEachChild(node, visit);
        };
        visit(parsed);
      }
      const ref = tokens[reference].offset;
      const declaration = tokens[pipeline].offset;
      return bindingScopes.some(
        (scope) =>
          scope.name === name &&
          ref >= scope.start &&
          ref < scope.end &&
          (declaration < scope.start || declaration >= scope.end)
      );
    };
    const isParameter = (index: number, name: string | undefined): boolean => {
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return false;
      for (const open of [...scopes[index]].reverse()) {
        let end = open - 1;
        if (tokens[end]?.text === '>' && tokens[end - 1]?.text === '=') end -= 2;
        if (tokens[end]?.text !== ')') continue;
        let depth = 1;
        let start = end - 1;
        for (; start >= 0 && depth; start--) {
          if (tokens[start].text === ')') depth++;
          else if (tokens[start].text === '(') depth--;
        }
        if (depth || ['if', 'while', 'for', 'switch', 'catch'].includes(tokens[start]?.text))
          continue;
        if (tokens.slice(start + 2, end).some((token) => token.text === name)) return true;
      }
      return false;
    };
    const pipelines: { index: number; name?: string; variable?: string }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].text !== 'superpipe' || tokens[i + 1]?.text !== '(') continue;
      const close = closeToken(tokens, i + 1);
      if (close < 0 || tokens[close + 1]?.text !== '(') continue;
      const end = closeToken(tokens, close + 1);
      if (end < 0) continue;
      const name = end === close + 3 ? stringToken(tokens[close + 2]?.text) : undefined;
      let variable: string | undefined;
      for (let j = i - 1; j >= 0 && i - j < 12; j--) {
        if ([';', '{', '}'].includes(tokens[j].text)) break;
        if (tokens[j].text === '=' && tokens[j - 2]?.text === 'const') {
          variable = tokens[j - 1].text;
          break;
        }
      }
      pipelines.push({ index: i, name, variable });
      if (!name) {
        if (end === close + 3 && isParameter(i, tokens[close + 2]?.text)) counts.unreadable++;
        else counts.dynamic++;
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (
        tokens[i].text === 'onRequest' &&
        tokens[i - 1]?.text === '.' &&
        tokens[i + 1]?.text === '('
      ) {
        const end = closeToken(tokens, i + 1);
        const comma = tokens.findIndex(
          (token, index) => index > i + 1 && index < end && token.text === ','
        );
        if (comma < 0) continue;
        const arg = tokens.slice(i + 2, comma).map((token) => token.text);
        if (arg.length === 1 && stringToken(arg[0])) continue;
        if ((arg.length === 1 && isParameter(i, arg[0])) || (arg.length === 3 && arg[1] === '.'))
          counts.unreadable++;
        else counts.dynamic++;
      }
      if (
        tokens[i].text !== 'defineOperation' ||
        tokens[i + 1]?.text !== '(' ||
        tokens[i + 2]?.text !== '{'
      )
        continue;
      const end = closeToken(tokens, i + 2);
      if (end < 0) {
        counts.unreadable++;
        continue;
      }
      let name: string | undefined;
      let executeStart = -1;
      let executeEnd = -1;
      for (let j = i + 3; j < end; j++) {
        if (tokens[j].text === 'name' && tokens[j + 1]?.text === ':')
          name = stringToken(tokens[j + 2]?.text);
        if (tokens[j].text === 'execute' && tokens[j + 1]?.text === ':') {
          executeStart = j + 2;
          let k = executeStart;
          while (k < end && tokens[k].text !== ',') {
            if (['(', '[', '{'].includes(tokens[k].text)) {
              const close = closeToken(tokens, k);
              if (close < 0) break;
              k = close + 1;
            } else k++;
          }
          executeEnd = k;
        }
        if (['(', '[', '{'].includes(tokens[j].text)) {
          const close = closeToken(tokens, j);
          if (close < 0) break;
          j = close;
        }
      }
      if (!name || executeStart < 0 || executeEnd < 0) {
        counts.unreadable++;
        i = end;
        continue;
      }
      const body = tokens.slice(executeStart, executeEnd).map((token) => token.text);
      const reached = pipelines.filter(
        (pipeline) =>
          (pipeline.index >= executeStart && pipeline.index < executeEnd) ||
          (pipeline.variable &&
            scopes[pipeline.index].every((part, index) => scopes[i][index] === part) &&
            ((body.length === 1 &&
              body[0] === pipeline.variable &&
              !bindingShadows(executeStart, pipeline.index, pipeline.variable)) ||
              body.some(
                (token, index) =>
                  token === pipeline.variable &&
                  (body[index - 1] !== '.' ||
                    (body[index - 2] === '.' && body[index - 3] === '.')) &&
                  body[index + 1] === '(' &&
                  !bindingShadows(executeStart + index, pipeline.index, token)
              )))
      );
      if (reached.length === 0) {
        if (body.includes('=>') || (body.includes('=') && body.includes('>'))) {
          if (
            body.some((token, index) => /^[A-Za-z_$][\w$]*$/.test(token) && body[index + 1] === '(')
          )
            counts.unreadable++;
          else counts.missing++;
        } else counts.unreadable++;
      } else if (!reached.some((pipeline) => pipeline.name === name)) counts.misnamed++;
      i = end;
    }
  }
  return counts;
}
