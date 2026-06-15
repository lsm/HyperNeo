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
const defaultConfigPath = 'docs/plans/architecture-refactor-execution-plan/file-size-ratchet.json';

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

function getChangedPaths(ref: string): Set<string> {
  const output = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return new Set(output.split('\n').filter(Boolean).map(toPosix));
}

function getChangedPathInfo(ref: string): Map<string, ChangedPathInfo> {
  const output = execFileSync('git', ['diff', '--name-status', `${ref}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const changedPaths = new Map<string, ChangedPathInfo>();

  for (const line of output.split('\n').filter(Boolean)) {
    const [status, firstPath, secondPath] = line.split('\t');
    const hasPreviousPath = status.startsWith('R') || status.startsWith('C');
    const path = toPosix(hasPreviousPath ? secondPath : firstPath);
    changedPaths.set(path, {
      status,
      path,
      previousPath: hasPreviousPath ? toPosix(firstPath) : null,
    });
  }

  return changedPaths;
}

function loadConfig(configPath: string): RatchetConfig {
  const absolutePath = resolve(repoRoot, configPath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as RatchetConfig;
}

function loadConfigFromGitRef(ref: string, configPath: string): RatchetConfig | null {
  try {
    const output = execFileSync('git', ['show', `${ref}:${configPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(output) as RatchetConfig;
  } catch {
    return null;
  }
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0];
  const divider = header.map(() => '---');
  return [header, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

const { configPath, changedFrom, json } = parseArgs();
const config = loadConfig(configPath);
const baseConfig = changedFrom ? loadConfigFromGitRef(changedFrom, configPath) : null;
const enforcementConfig = baseConfig ?? config;
const baselineConfigSource = baseConfig
  ? `${changedFrom}:${configPath}`
  : changedFrom
    ? `${configPath} (base ref has no baseline yet)`
    : configPath;
const files: SourceFile[] = [];
walk(resolve(repoRoot, 'packages'), files);

const changedPaths = changedFrom ? getChangedPaths(changedFrom) : null;
const changedPathInfo = changedFrom
  ? getChangedPathInfo(changedFrom)
  : new Map<string, ChangedPathInfo>();
const scannedFiles = changedPaths ? files.filter((file) => changedPaths.has(file.path)) : files;
const oversized = scannedFiles
  .filter((file) => file.lines > enforcementConfig.hardLineCount)
  .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
const overTarget = scannedFiles.filter((file) => file.lines > enforcementConfig.targetLineCount);

function getBaselineEntry(filePath: string): AllowlistEntry | undefined {
  const changedInfo = changedPathInfo.get(filePath);
  if (changedInfo?.previousPath && changedInfo.status.startsWith('R')) {
    return enforcementConfig.allowlist[changedInfo.previousPath];
  }
  return enforcementConfig.allowlist[filePath];
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

const staleAllowlistEntries = Object.entries(config.allowlist)
  .filter(([path, entry]) => {
    const absolutePath = resolve(repoRoot, path);
    return !existsSync(absolutePath) || countLines(absolutePath) < entry.maxLines;
  })
  .map(([path]) => path)
  .sort();

const report = {
  scope: config.scope,
  targetLineCount: config.targetLineCount,
  hardLineCount: config.hardLineCount,
  changedFrom,
  baselineConfigSource,
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

exit(violations.length > 0 ? 1 : 0);
