import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

type AllowlistEntry = {
  maxLines: number;
  followUp: string;
};

type RatchetConfig = {
  targetLineCount: number;
  hardLineCount: number;
  scope: string;
  allowlist: Record<string, AllowlistEntry>;
};

type SourceFile = {
  path: string;
  absolutePath: string;
  lines: number;
};

type ChangedPathInfo = {
  status: string;
  path: string;
  previousPath: string | null;
};

type ReportFile = {
  file: string;
  lines: number;
  maxLines: number | null;
  followUp: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfigPath =
  'docs/architecture/target-architecture/execution-plan/file-size-ratchet.json';
const legacyConfigPaths = [
  'docs/plans/architecture-refactor-execution-plan/file-size-ratchet.json',
];

function parseArgs(): { configPath: string; changedFrom: string | null; json: boolean } {
  let configPath = defaultConfigPath;
  let changedFrom: string | null = null;
  let json = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      configPath = argv[++i] ?? configPath;
    } else if (arg === '--changed-from') {
      changedFrom = argv[++i] ?? null;
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { configPath, changedFrom, json };
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function toRepoPath(path: string): string {
  return toPosix(relative(repoRoot, resolve(repoRoot, path)));
}

function countLines(path: string): number {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) return 0;
  const newlineCount = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? newlineCount : newlineCount + 1;
}

function isProductionSource(path: string): boolean {
  if (!/\.(ts|tsx|js|jsx)$/.test(path)) return false;
  if (path.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path)) return false;
  if (path.includes('/__tests__/')) return false;
  return /^packages\/[^/]+\/src\//.test(path);
}

function walk(dir: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(absolutePath, out);
      continue;
    }
    if (!stat.isFile()) continue;

    const path = toPosix(relative(repoRoot, absolutePath));
    if (!isProductionSource(path)) continue;
    out.push({ path, absolutePath, lines: countLines(absolutePath) });
  }
}

function getGitLines(args: string[]): string[] {
  const output = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\n').filter(Boolean).map(toPosix);
}

function addChangedPathInfo(
  changedPaths: Map<string, ChangedPathInfo>,
  line: string,
  fallbackStatus = 'M'
): void {
  const [rawStatus, firstPath, secondPath] = line.split('\t');
  const status = rawStatus || fallbackStatus;
  const hasPreviousPath = status.startsWith('R') || status.startsWith('C');
  const path = toPosix(hasPreviousPath ? secondPath : firstPath);
  changedPaths.set(path, {
    status,
    path,
    previousPath: hasPreviousPath ? toPosix(firstPath) : null,
  });
}

function getChangedPaths(ref: string): Set<string> {
  return new Set([
    ...getGitLines(['diff', '-M', '--name-only', `${ref}...HEAD`]),
    ...getGitLines(['diff', '-M', '--name-only', '--cached']),
    ...getGitLines(['diff', '-M', '--name-only']),
    ...getGitLines(['ls-files', '--others', '--exclude-standard']),
  ]);
}

function getChangedPathInfo(ref: string): Map<string, ChangedPathInfo> {
  const changedPaths = new Map<string, ChangedPathInfo>();

  for (const line of getGitLines(['diff', '-M', '--name-status', `${ref}...HEAD`])) {
    addChangedPathInfo(changedPaths, line);
  }
  for (const line of getGitLines(['diff', '-M', '--name-status', '--cached'])) {
    addChangedPathInfo(changedPaths, line);
  }
  for (const line of getGitLines(['diff', '-M', '--name-status'])) {
    addChangedPathInfo(changedPaths, line);
  }
  for (const path of getGitLines(['ls-files', '--others', '--exclude-standard'])) {
    changedPaths.set(path, { status: 'A', path, previousPath: null });
  }

  return changedPaths;
}

function loadConfig(configPath: string): RatchetConfig {
  const absolutePath = resolve(repoRoot, configPath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as RatchetConfig;
}

function tryLoadConfigFromGitRef(
  ref: string,
  configPath: string
): { config: RatchetConfig; path: string } | null {
  try {
    const output = execFileSync('git', ['show', `${ref}:${configPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { config: JSON.parse(output) as RatchetConfig, path: configPath };
  } catch {
    return null;
  }
}

function loadConfigFromGitRef(
  ref: string,
  configPath: string
): { config: RatchetConfig; path: string } | null {
  const paths = [configPath, ...legacyConfigPaths.filter((path) => path !== configPath)];
  for (const path of paths) {
    const loaded = tryLoadConfigFromGitRef(ref, path);
    if (loaded) return loaded;
  }
  return null;
}

function stableConfigJson(configSource: RatchetConfig): string {
  return JSON.stringify(configSource);
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0];
  const divider = header.map(() => '---');
  return [header, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

const { configPath, changedFrom, json } = parseArgs();
const configRepoPath = toRepoPath(configPath);
const config = loadConfig(configPath);
const baseConfigResult = changedFrom ? loadConfigFromGitRef(changedFrom, configRepoPath) : null;
const baseConfig = baseConfigResult?.config ?? null;
const thresholdConfig = baseConfig
  ? {
      ...config,
      targetLineCount: Math.min(config.targetLineCount, baseConfig.targetLineCount),
      hardLineCount: Math.min(config.hardLineCount, baseConfig.hardLineCount),
    }
  : config;
const baselineConfigSource = baseConfig
  ? `${changedFrom}:${baseConfigResult?.path ?? configRepoPath}`
  : changedFrom
    ? `${configRepoPath} (base ref has no baseline yet)`
    : configRepoPath;
const files: SourceFile[] = [];
walk(resolve(repoRoot, 'packages'), files);

const changedPaths = changedFrom ? getChangedPaths(changedFrom) : null;
const changedPathInfo = changedFrom
  ? getChangedPathInfo(changedFrom)
  : new Map<string, ChangedPathInfo>();
const ratchetConfigPathChanged =
  changedPaths?.has(configRepoPath) ||
  legacyConfigPaths.some((legacyConfigPath) => changedPaths?.has(legacyConfigPath)) ||
  false;
const ratchetConfigChanged =
  ratchetConfigPathChanged &&
  (!baseConfig || stableConfigJson(config) !== stableConfigJson(baseConfig));
const scanReason =
  changedPaths && ratchetConfigChanged
    ? `ratchet config changed; scanning all production source files`
    : changedPaths
      ? `changed production source files only`
      : `all production source files`;
const scannedFiles =
  changedPaths && !ratchetConfigChanged
    ? files.filter((file) => changedPaths.has(file.path))
    : files;
const oversized = scannedFiles
  .filter((file) => file.lines > thresholdConfig.hardLineCount)
  .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
const overTarget = scannedFiles.filter((file) => file.lines > thresholdConfig.targetLineCount);

function getAllowlistEntry(
  configSource: RatchetConfig,
  filePath: string,
  options: { usePreviousPath?: boolean } = {}
): AllowlistEntry | undefined {
  const changedInfo = changedPathInfo.get(filePath);
  if (options.usePreviousPath && changedInfo?.previousPath && changedInfo.status.startsWith('R')) {
    return configSource.allowlist[changedInfo.previousPath];
  }
  return configSource.allowlist[filePath];
}

function getBaselineEntry(filePath: string): AllowlistEntry | undefined {
  const currentEntry = getAllowlistEntry(config, filePath);
  const baseEntry = baseConfig
    ? getAllowlistEntry(baseConfig, filePath, { usePreviousPath: true })
    : undefined;
  if (!currentEntry) return undefined;
  if (baseConfig && !baseEntry) return undefined;
  if (!baseEntry) return currentEntry;
  return currentEntry.maxLines <= baseEntry.maxLines ? currentEntry : baseEntry;
}

function toReportFile(file: SourceFile): ReportFile {
  const allowlistEntry = getBaselineEntry(file.path);
  const changedInfo = changedPathInfo.get(file.path);
  const isNewFile = changedInfo?.status === 'A' || changedInfo?.status.startsWith('C');
  return {
    file: file.path,
    lines: file.lines,
    maxLines: isNewFile ? null : (allowlistEntry?.maxLines ?? null),
    followUp: isNewFile
      ? 'new production source file exceeds hard ceiling'
      : (allowlistEntry?.followUp ?? 'missing allowlist entry'),
  };
}

const violations = oversized.filter((file) => {
  const changedInfo = changedPathInfo.get(file.path);
  if (changedInfo?.status === 'A' || changedInfo?.status.startsWith('C')) return true;

  const allowlistEntry = getBaselineEntry(file.path);
  return !allowlistEntry || file.lines > allowlistEntry.maxLines;
});

const staleAllowlistCandidates =
  changedPaths && !ratchetConfigChanged
    ? [
        ...scannedFiles
          .map((file) => [file.path, config.allowlist[file.path]] as const)
          .filter((entry): entry is readonly [string, AllowlistEntry] => Boolean(entry[1])),
        ...Array.from(changedPathInfo.values())
          .map((changedInfo) =>
            changedInfo.status.startsWith('R')
              ? changedInfo.previousPath
              : changedInfo.status === 'D'
                ? changedInfo.path
                : null
          )
          .filter((path): path is string => Boolean(path))
          .map((path) => [path, config.allowlist[path]] as const)
          .filter((entry): entry is readonly [string, AllowlistEntry] => Boolean(entry[1])),
      ]
    : Object.entries(config.allowlist);

const staleAllowlistEntries = staleAllowlistCandidates
  .filter(([path, entry]) => {
    const absolutePath = resolve(repoRoot, path);
    return !existsSync(absolutePath) || countLines(absolutePath) !== entry.maxLines;
  })
  .map(([path]) => path)
  .sort();

const report = {
  scope: config.scope,
  targetLineCount: thresholdConfig.targetLineCount,
  hardLineCount: thresholdConfig.hardLineCount,
  changedFrom,
  baselineConfigSource,
  ratchetConfigChanged,
  scanReason,
  scannedFiles: scannedFiles.length,
  overTarget: overTarget.length,
  oversized: oversized.length,
  violations: violations.map(toReportFile),
  staleAllowlistEntries,
  topOversized: oversized.slice(0, 25).map(toReportFile),
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('# Architecture File-Size Report');
  console.log('');
  console.log(`Scope: ${report.scope}`);
  console.log(`Target: ${report.targetLineCount} lines`);
  console.log(`Temporary hard ceiling: ${report.hardLineCount} lines`);
  if (changedFrom) console.log(`Changed-from ref: ${changedFrom}`);
  console.log(`Baseline config: ${report.baselineConfigSource}`);
  console.log(`Scan reason: ${report.scanReason}`);
  console.log('');
  console.log(`Files scanned: ${report.scannedFiles}`);
  console.log(`Files over target: ${report.overTarget}`);
  console.log(`Files over hard ceiling: ${report.oversized}`);
  console.log(`Violations: ${report.violations.length}`);

  if (report.topOversized.length > 0) {
    console.log('');
    console.log('## Top Oversized Files');
    console.log('');
    console.log(
      formatTable([
        ['Lines', 'Baseline', 'Follow-up', 'File'],
        ...report.topOversized.map((file) => [
          String(file.lines),
          file.maxLines === null ? 'missing' : String(file.maxLines),
          file.followUp,
          file.file,
        ]),
      ])
    );
  }

  if (report.violations.length > 0) {
    console.log('');
    console.log('## Violations');
    console.log('');
    console.log(
      formatTable([
        ['Lines', 'Baseline', 'Follow-up', 'File'],
        ...report.violations.map((file) => [
          String(file.lines),
          file.maxLines === null ? 'missing' : String(file.maxLines),
          file.followUp,
          file.file,
        ]),
      ])
    );
  }

  if (report.staleAllowlistEntries.length > 0) {
    console.log('');
    console.log('## Stale Allowlist Entries');
    console.log('');
    for (const file of report.staleAllowlistEntries) {
      console.log(`- ${file}`);
    }
  }
}

exit(violations.length > 0 || staleAllowlistEntries.length > 0 ? 1 : 0);
