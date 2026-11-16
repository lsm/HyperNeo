import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

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
const OPEN_CALL = /\(\s*(?:[\w.()]+\s*,\s*)?$/;
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
  const start = Math.max(0, index - 70);
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

function loadRepository(root: string): SystemMap {
  const sources = new Map(
    git(root, 'ls-files', '--', 'packages')
      .filter((path) => isSource(path) && existsSync(join(root, path)))
      .map((path) => [path, readFileSync(join(root, path), 'utf8')])
  );
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

const USAGE = `Usage:
  bun run system-map where <name>            who defines, calls, reads or writes an operation,
                                             RPC method, event or table
  bun run system-map impact <file>...        what the planned files are linked to outside the plan
  bun run system-map impact --diff [base]    the same for files changed since base (origin/dev)`;

function main(args: readonly string[]): number {
  const root = process.cwd();
  const [command, ...rest] = args;
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

if (import.meta.main) process.exit(main(process.argv.slice(2)));
