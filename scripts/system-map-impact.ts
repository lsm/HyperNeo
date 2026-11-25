import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatImpact, impact, isSource, loadRepository, type Impact } from './system-map.ts';

const reads = ['map', 'impact', 'where', 'routes'] as const;
type Read = (typeof reads)[number];
type ObjectFields = Record<string, unknown>;

interface PullRequest {
  head: { sha: string };
  base: { sha: string };
  body: string | null;
  labels: { name: string }[];
}

const usage = 'Usage: bun scripts/system-map-impact.ts --print [base] | --check <event> <diff>';
const fence = '```system-map-impact';
const sha = /^[0-9a-f]{40}$/;

function run(command: string[], input?: string): string {
  const result = Bun.spawnSync(command, {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')}: ${result.stderr.toString().trim() || result.signalCode || result.exitCode}`
    );
  }
  return result.stdout.toString();
}

function requiredPaths(head: Impact[], base: Impact[]): string[] {
  const required = new Set<string>();
  for (const [index, item] of head.entries()) {
    if (!item.known) required.add(item.path);
    const owned = new Set(item.owned.map(({ link }) => `${link.kind} ${link.name} ${link.role}`));
    for (const { peers } of item.owned) {
      for (const peer of peers) required.add(peer.path);
    }
    for (const { link, peers } of base[index].owned) {
      if (owned.has(`${link.kind} ${link.name} ${link.role}`)) continue;
      for (const peer of peers) required.add(peer.path);
    }
  }
  return [...required].sort();
}

function requiredReads(paths: string[], plan: string[]): Read[] {
  const helper = fileURLToPath(new URL('./lib/inert-docs.sh', import.meta.url));
  const code = new Set(
    run(
      [
        'bash',
        '-c',
        'set -e; . "$1"; while IFS= read -r -d "" path; do if ! is_inert_doc "$path"; then printf "%s\\0" "$path"; fi; done',
        'bash',
        helper,
      ],
      `${paths.join('\0')}\0`
    )
      .split('\0')
      .filter(Boolean)
  );
  const design = paths.some((path) => path.startsWith('docs/design/'));
  const map = design || paths.length > code.size || !plan.length;
  const impact = design || code.size > 0;
  return [...(map ? ['map' as const] : []), ...(impact ? ['impact' as const] : [])];
}

function jsonLine(line: string): ObjectFields {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as ObjectFields)
      : {};
  } catch {
    return {};
  }
}

function validate(body: string, head: string, required: Read[], paths: string[]) {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const start = lines.indexOf(fence);
  const end = lines.indexOf('```', start + 1);
  const block =
    start >= 0 && end > start && start === lines.lastIndexOf(fence)
      ? lines.slice(start + 1, end)
      : [];
  const [header = {}, ...entries] = block.map(jsonLine);
  const claims: unknown[] = Array.isArray(header.read) ? header.read : [];
  const readErrors =
    Number(header.version !== 1 || !Array.isArray(header.read)) +
    required.filter((name) => !claims.includes(name)).length +
    claims.filter((name) => !reads.some((read) => read === name)).length +
    claims.length -
    new Set(claims).size;
  const remaining = new Set(paths);
  let pathErrors = 0;
  let reasonErrors = 0;
  for (const { path, reason } of entries) {
    if (typeof path !== 'string' || !remaining.delete(path)) pathErrors++;
    if (typeof reason !== 'string' || !reason.trim()) reasonErrors++;
  }
  pathErrors += remaining.size;
  const stale = header.head !== head;
  return { readErrors, pathErrors, reasonErrors, stale };
}

function printBlock(head: string, base: string, read: Read[], paths: string[]): string {
  return [
    fence,
    JSON.stringify({ version: 1, head, base, read }),
    ...paths.map((path) => JSON.stringify({ path, reason: '' })),
    '```',
  ].join('\n');
}

function report(head: string, base: string, reports: string[]) {
  const github = process.env.GITHUB_ACTIONS === 'true';
  const marker = randomUUID();
  if (github)
    console.log(`::group::System map on ${head} against ${base}\n::stop-commands::${marker}`);
  console.log(reports.join('\n\n'));
  if (github) console.log(`::${marker}::\n::endgroup::`);
}

function main(args: string[]): number {
  const [mode, input, diff, ...extra] = args;
  const print = mode === '--print' && diff === undefined;
  if (!print && (mode !== '--check' || !input || !diff || extra.length)) throw new Error(usage);

  const head = run(['git', 'rev-parse', '--verify', 'HEAD']).trim();
  let command = 'read exact base/head and diff';
  try {
    const pr: PullRequest | undefined = print
      ? undefined
      : JSON.parse(readFileSync(input, 'utf8')).pull_request;
    if (!print && !pr) throw new Error('expected a pull request event');
    const target =
      pr?.base.sha ??
      run([
        'git',
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${input ?? 'origin/dev'}^{commit}`,
      ]).trim();
    const base = run(['git', 'merge-base', target, head]).trim();
    if (!sha.test(base) || !sha.test(head) || (pr && head !== pr.head.sha)) {
      throw new Error('checkout does not match the event SHAs');
    }
    if (run(['git', 'status', '--porcelain', '--untracked-files=no'])) {
      throw new Error('tracked files differ from HEAD');
    }
    const pathList = print
      ? run(['git', 'diff', '--name-only', '--no-renames', '-z', base, head, '--'])
      : readFileSync(diff, 'utf8');
    if (pathList && !pathList.endsWith('\0')) throw new Error('expected a NUL-terminated diff');
    const paths = pathList.split('\0').filter(Boolean);
    const plan = paths.filter(isSource);
    command = 'system-map impact (base and head)';
    const before = impact(loadRepository(process.cwd(), base), plan);
    const after = impact(loadRepository(process.cwd()), plan);
    command = 'system-map map';
    const map = run([
      process.execPath,
      fileURLToPath(new URL('./system-map.ts', import.meta.url)),
      'map',
    ]);
    command = 'determine required attestations';
    const read = requiredReads(paths, plan);
    const required = pr?.labels.some(({ name }) => name === 'revert')
      ? []
      : requiredPaths(after, before);
    const block = printBlock(head, base, read, required);
    if (print) {
      console.log(block);
      return 0;
    }
    report(head, base, [
      map.trimEnd(),
      `Base impact\n${formatImpact(before)}`,
      `Head impact\n${formatImpact(after)}`,
      block,
    ]);
    const { readErrors, pathErrors, reasonErrors, stale } = validate(
      pr?.body ?? '',
      head,
      read,
      required
    );
    if (!readErrors && !pathErrors && !reasonErrors && !stale) return 0;
    const error = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
    console.error(
      `${error}System map check failed: ${readErrors} read, ${pathErrors} path, ${reasonErrors} reason; head ${stale ? 'stale' : 'current'}. Run system-map-impact.ts --print and use the collapsed CI report and replacement block; author read entries are claims.`
    );
    return 1;
  } catch (error) {
    throw new Error(
      `${command} failed at head ${head}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
