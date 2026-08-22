import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SuiteName = 'daemon-unit' | 'daemon-online' | 'web';

export interface SuiteTiming {
  name: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeSeconds: number;
}

export interface JunitTimings {
  reported: SuiteTiming | null;
  suites: SuiteTiming[];
}

export interface FileRow {
  bucket: string;
  file: string;
  suite: SuiteName | null;
  repoPath: string | null;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeSeconds: number;
}

export interface BucketRow {
  bucket: string;
  junitPath: string;
  files: number;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeSeconds: number;
  reportedTimeSeconds: number | null;
}

export interface CoverageRow {
  suite: SuiteName;
  expected: number;
  covered: number;
  missing: string[];
}

export interface BalanceReport {
  buckets: BucketRow[];
  files: FileRow[];
  duplicates: { file: string; buckets: string[] }[];
  unresolvedPaths: { bucket: string; path: string }[];
  coverage: CoverageRow[];
  coverageNote: string | null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suiteRoots: { root: string; suite: SuiteName }[] = [
  { root: 'packages/daemon/tests/unit', suite: 'daemon-unit' },
  { root: 'packages/shared/tests', suite: 'daemon-unit' },
  { root: 'packages/daemon/tests/online', suite: 'daemon-online' },
  { root: 'packages/web/src', suite: 'web' },
];
const pathRoots = ['packages/daemon', 'packages/shared', 'packages/web'];

function readXmlAttribute(attrs: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = attrs.match(new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : null;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function toNumber(value: string | null): number {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseJunitTimings(xml: string): JunitTimings {
  const rootMatch = xml.match(/<testsuites\b([^>]*)>/);
  const reported: SuiteTiming | null = rootMatch
    ? {
        name: 'testsuites',
        tests: toNumber(readXmlAttribute(rootMatch[1], 'tests')),
        failures: toNumber(readXmlAttribute(rootMatch[1], 'failures')),
        errors: toNumber(readXmlAttribute(rootMatch[1], 'errors')),
        skipped: toNumber(readXmlAttribute(rootMatch[1], 'skipped')),
        timeSeconds: toNumber(readXmlAttribute(rootMatch[1], 'time')),
      }
    : null;

  const suites: SuiteTiming[] = [];
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    suites.push({
      name: readXmlAttribute(match[1], 'name') ?? '(unnamed suite)',
      tests: toNumber(readXmlAttribute(match[1], 'tests')),
      failures: toNumber(readXmlAttribute(match[1], 'failures')),
      errors: toNumber(readXmlAttribute(match[1], 'errors')),
      skipped: toNumber(readXmlAttribute(match[1], 'skipped')),
      timeSeconds: toNumber(readXmlAttribute(match[1], 'time')),
    });
  }

  return { reported, suites };
}

export function bucketLabelFromPath(path: string): string {
  const base = basename(path).replace(/\.xml$/i, '');
  if (base === 'junit' || base === '') {
    const parent = basename(dirname(path));
    return parent === '' ? path : parent;
  }
  return base.replace(/^junit-/, '') || base;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function resolveSuitePath(rawPath: string): {
  repoPath: string | null;
  suite: SuiteName | null;
} {
  let candidate: string | null = null;
  if (rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    const rel = toPosix(relative(repoRoot, rawPath));
    candidate = rel !== '' && !rel.startsWith('..') ? rel : null;
  } else {
    for (const root of pathRoots) {
      if (existsSync(resolve(repoRoot, root, rawPath))) {
        candidate = `${root}/${toPosix(rawPath)}`;
        break;
      }
    }
  }
  if (candidate === null) {
    return { repoPath: null, suite: null };
  }
  for (const { root, suite } of suiteRoots) {
    if (candidate === root || candidate.startsWith(`${root}/`)) {
      return { repoPath: candidate, suite };
    }
  }
  return { repoPath: candidate, suite: null };
}

export function discoverJunitFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    const stat = statSync(input, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      files.push(input);
      continue;
    }
    if (stat?.isDirectory()) {
      const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            visit(path);
          } else if (entry.isFile() && path.endsWith('.xml')) {
            files.push(path);
          }
        }
      };
      visit(input);
      continue;
    }
    throw new Error(`input path not found: ${input} (pass junit files or directories)`);
  }
  return [...new Set(files)].sort();
}

export function buildReport(
  junitInputs: { path: string; xml: string }[],
  options: { coverage?: boolean } = {}
): BalanceReport {
  const buckets: BucketRow[] = [];
  const files: FileRow[] = [];

  for (const input of junitInputs) {
    const timings = parseJunitTimings(input.xml);
    const bucket = bucketLabelFromPath(input.path);
    buckets.push({
      bucket,
      junitPath: input.path,
      files: timings.suites.length,
      tests: timings.suites.reduce((sum, suite) => sum + suite.tests, 0),
      failures: timings.suites.reduce((sum, suite) => sum + suite.failures, 0),
      errors: timings.suites.reduce((sum, suite) => sum + suite.errors, 0),
      skipped: timings.suites.reduce((sum, suite) => sum + suite.skipped, 0),
      timeSeconds: timings.suites.reduce((sum, suite) => sum + suite.timeSeconds, 0),
      reportedTimeSeconds: timings.reported?.timeSeconds ?? null,
    });
    for (const suite of timings.suites) {
      const resolved = resolveSuitePath(suite.name);
      files.push({
        bucket,
        file: suite.name,
        suite: resolved.suite,
        repoPath: resolved.repoPath,
        tests: suite.tests,
        failures: suite.failures,
        errors: suite.errors,
        skipped: suite.skipped,
        timeSeconds: suite.timeSeconds,
      });
    }
  }

  buckets.sort((a, b) => b.timeSeconds - a.timeSeconds || a.bucket.localeCompare(b.bucket));
  files.sort((a, b) => b.timeSeconds - a.timeSeconds || a.file.localeCompare(b.file));

  const byRepoPath = new Map<string, Set<string>>();
  for (const row of files) {
    if (!byRepoPath.has(row.file)) {
      byRepoPath.set(row.file, new Set());
    }
    byRepoPath.get(row.file)?.add(row.bucket);
  }
  const duplicates = [...byRepoPath.entries()]
    .filter(([, bucketSet]) => bucketSet.size > 1)
    .map(([file, bucketSet]) => ({ file, buckets: [...bucketSet].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const unresolvedPaths = files
    .filter((row) => row.repoPath === null)
    .map((row) => ({ bucket: row.bucket, path: row.file }));

  const suitesSeen = new Set(files.map((row) => row.suite).filter((suite) => suite !== null));
  for (const suite of suitesFromJunitPaths(junitInputs.map((input) => input.path))) {
    suitesSeen.add(suite);
  }
  const coverage: CoverageRow[] = [];
  let coverageNote: string | null = null;
  if (options.coverage === false) {
    return { buckets, files, duplicates, unresolvedPaths, coverage, coverageNote };
  }
  const oracleFailures: string[] = [];
  for (const suite of ['daemon-unit', 'daemon-online', 'web'] as SuiteName[]) {
    if (!suitesSeen.has(suite)) {
      continue;
    }
    let expected: Set<string>;
    try {
      expected = expectedFilesForSuite(suite);
    } catch (error) {
      oracleFailures.push(`${suite}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const covered = new Set(
      files.filter((row) => row.suite === suite && row.repoPath !== null).map((row) => row.repoPath)
    );
    const missing = [...expected].filter((path) => !covered.has(path)).sort();
    coverage.push({ suite, expected: expected.size, covered: covered.size, missing });
  }
  if (oracleFailures.length > 0) {
    coverageNote = `coverage oracle unavailable for: ${oracleFailures.join('; ')}`;
  }

  return { buckets, files, duplicates, unresolvedPaths, coverage, coverageNote };
}

function suitesFromJunitPaths(paths: string[]): SuiteName[] {
  const suites: SuiteName[] = [];
  for (const path of paths) {
    const segments = toPosix(path).split('/');
    const base = segments[segments.length - 1] ?? '';
    if (segments.some((segment) => segment.startsWith('daemon-online'))) {
      suites.push('daemon-online');
    }
    if (
      segments.some((segment) => segment.startsWith('daemon-unit-junit')) ||
      (segments.includes('test-results') && segments.includes('daemon'))
    ) {
      suites.push('daemon-unit');
    }
    if (segments.includes('web') || segments.includes('web-junit') || base === 'junit-web.xml') {
      suites.push('web');
    }
  }
  return suites;
}

function walkTestFiles(root: string, out: string[]): void {
  for (const entry of readdirSync(resolve(repoRoot, root), { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      walkTestFiles(path, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('_test.ts') ||
        entry.name.endsWith('.test.tsx') ||
        entry.name.endsWith('.spec.ts') ||
        entry.name.endsWith('.spec.tsx'))
    ) {
      out.push(path);
    }
  }
}

function expandShardPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const absolute = resolve(repoRoot, path);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      walkTestFiles(toPosix(relative(repoRoot, absolute)), out);
    } else if (stat?.isFile()) {
      out.push(toPosix(relative(repoRoot, absolute)));
    }
  }
  return out;
}

function runOracle(command: string): string[] {
  const output = execFileSync('bash', ['-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

const expectedFilesCache = new Map<SuiteName, Set<string>>();

export function expectedFilesForSuite(suite: SuiteName): Set<string> {
  const cached = expectedFilesCache.get(suite);
  if (cached) {
    return cached;
  }
  const resolved = resolveExpectedFilesForSuite(suite);
  expectedFilesCache.set(suite, resolved);
  return resolved;
}

function resolveExpectedFilesForSuite(suite: SuiteName): Set<string> {
  if (suite === 'daemon-unit') {
    const paths = runOracle(
      'source scripts/test-daemon.sh; for shard in "${SHARDS[@]}"; do shard_paths "$shard"; done'
    );
    return new Set(expandShardPaths(paths));
  }
  if (suite === 'daemon-online') {
    const paths = runOracle(
      'source scripts/test-online.sh; online_all_modules | while IFS= read -r m; do online_module_paths "$m"; done'
    );
    return new Set(paths.map((path) => `packages/daemon/${path}`));
  }
  const files: string[] = [];
  walkTestFiles('packages/web/src', files);
  return new Set(files);
}

function formatSeconds(seconds: number): string {
  if (seconds > 0 && seconds < 1) {
    return `${Math.round(seconds * 1000)}ms`;
  }
  return `${seconds.toFixed(1)}s`;
}

export function renderMarkdown(report: BalanceReport, top: number): string {
  const lines: string[] = [];
  const totalTests = report.buckets.reduce((sum, bucket) => sum + bucket.tests, 0);
  const totalTime = report.buckets.reduce((sum, bucket) => sum + bucket.timeSeconds, 0);
  const totalFiles = report.buckets.reduce((sum, bucket) => sum + bucket.files, 0);

  lines.push('# CI test-duration balance report', '');
  lines.push(
    `${report.buckets.length} bucket(s), ${totalFiles} test file(s), ${totalTests} test(s), ${formatSeconds(totalTime)} test time`,
    ''
  );

  lines.push('## Bucket totals', '');
  lines.push('| bucket | files | tests | time | share | junit |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const bucket of report.buckets) {
    const share = totalTime > 0 ? `${((bucket.timeSeconds / totalTime) * 100).toFixed(1)}%` : '-';
    lines.push(
      `| ${bucket.bucket} | ${bucket.files} | ${bucket.tests} | ${formatSeconds(bucket.timeSeconds)} | ${share} | ${bucket.junitPath} |`
    );
  }
  lines.push('');
  if (report.buckets.length > 1) {
    const times = report.buckets.map((bucket) => bucket.timeSeconds);
    const max = Math.max(...times);
    const min = Math.min(...times);
    const slowest = report.buckets.find((bucket) => bucket.timeSeconds === max)?.bucket ?? '?';
    const fastest = report.buckets.find((bucket) => bucket.timeSeconds === min)?.bucket ?? '?';
    const ratio = min > 0 ? `, ${(max / min).toFixed(1)}x` : '';
    lines.push(
      `spread: slowest ${slowest} ${formatSeconds(max)} vs fastest ${fastest} ${formatSeconds(min)} (max−min ${formatSeconds(max - min)}${ratio})`,
      ''
    );
  }

  lines.push(
    `## Per-file durations (top ${Math.min(top, report.files.length)} of ${report.files.length})`,
    ''
  );
  lines.push('| bucket | time | tests | file |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of report.files.slice(0, top)) {
    lines.push(
      `| ${row.bucket} | ${formatSeconds(row.timeSeconds)} | ${row.tests} | ${row.repoPath ?? row.file} |`
    );
  }
  lines.push('');

  const failed = report.files.filter((row) => row.failures > 0 || row.errors > 0);
  if (failed.length > 0) {
    lines.push(
      `${failed.length} file(s) reported failures/errors — their durations may be truncated:`
    );
    for (const row of failed) {
      lines.push(`- ${row.bucket} ${row.repoPath ?? row.file} (${row.failures}f/${row.errors}e)`);
    }
    lines.push('');
  }

  if (report.duplicates.length > 0) {
    lines.push('Files present in more than one bucket:');
    for (const duplicate of report.duplicates) {
      lines.push(`- ${duplicate.file}: ${duplicate.buckets.join(', ')}`);
    }
    lines.push('');
  }

  if (report.unresolvedPaths.length > 0) {
    lines.push(`${report.unresolvedPaths.length} path(s) not found under ${pathRoots.join(', ')}:`);
    for (const entry of report.unresolvedPaths.slice(0, 20)) {
      lines.push(`- [${entry.bucket}] ${entry.path}`);
    }
    lines.push('');
  }

  if (report.coverage.length > 0) {
    lines.push('## Coverage (files run vs shard-config-resolved files)', '');
    for (const row of report.coverage) {
      if (row.missing.length === 0) {
        lines.push(`- ${row.suite}: ${row.covered}/${row.expected} covered`);
        continue;
      }
      lines.push(
        `- ${row.suite}: ${row.covered}/${row.expected} covered, ${row.missing.length} missing`
      );
      for (const path of row.missing.slice(0, 50)) {
        lines.push(`  - ${path}`);
      }
      if (row.missing.length > 50) {
        lines.push(`  - … and ${row.missing.length - 50} more`);
      }
    }
    lines.push('');
  }
  if (report.coverageNote !== null) {
    lines.push(report.coverageNote, '');
  }

  return lines.join('\n');
}

interface CliOptions {
  inputs: string[];
  top: number;
  json: boolean;
  noCoverage: boolean;
  help: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const inputs: string[] = [];
  let top = 30;
  let json = false;
  let noCoverage = false;
  let help = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--top') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--top expects a positive integer, got '${value}'`);
      }
      top = value;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-coverage') {
      noCoverage = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  if (!help && inputs.length === 0) {
    throw new Error('no junit inputs given');
  }
  return { inputs, top, json, noCoverage, help };
}

const usage = `usage: bun run scripts/ci-balance-report.ts [options] <junit-file-or-dir>...

Parses vitest junit XML into per-file test durations and per-bucket totals so
shard splits can be rebalanced on measured data instead of file counts.

  <input>            junit XML file, or a directory scanned recursively for *.xml
                     (standard layouts: test-results/daemon/junit-<shard>.xml,
                     test-results/daemon-online-<module>/junit-<module>.xml,
                     test-results/web/junit-web.xml — the bucket label is derived
                     from the file name)
  --top N            per-file table rows (default 30)
  --json             print the raw report object instead of markdown
  --no-coverage      skip the expected-files coverage check

When GITHUB_STEP_SUMMARY is set the markdown report is appended to it.`;

export function main(args = process.argv.slice(2)): number {
  let options: CliOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${usage}\n\nerror: ${message}`);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }

  let junitPaths: string[];
  try {
    junitPaths = discoverJunitFiles(options.inputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 2;
  }
  if (junitPaths.length === 0) {
    console.error(`no junit XML files found under: ${options.inputs.join(', ')}`);
    return 2;
  }

  const report = buildReport(
    junitPaths.map((path) => ({ path, xml: readFileSync(path, 'utf8') })),
    {
      coverage: !options.noCoverage,
    }
  );

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const markdown = renderMarkdown(report, options.top);
    console.log(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: 'a' });
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
