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

function loadConfig(configPath: string): RatchetConfig {
  const absolutePath = resolve(repoRoot, configPath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as RatchetConfig;
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0];
  const divider = header.map(() => '---');
  return [header, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

const { configPath, changedFrom, json } = parseArgs();
const config = loadConfig(configPath);
const files: SourceFile[] = [];
walk(resolve(repoRoot, 'packages'), files);

const changedPaths = changedFrom ? getChangedPaths(changedFrom) : null;
const scannedFiles = changedPaths ? files.filter((file) => changedPaths.has(file.path)) : files;
const oversized = scannedFiles
  .filter((file) => file.lines > config.hardLineCount)
  .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
const overTarget = scannedFiles.filter((file) => file.lines > config.targetLineCount);

const violations = oversized.filter((file) => {
  const allowlistEntry = config.allowlist[file.path];
  return !allowlistEntry || file.lines > allowlistEntry.maxLines;
});

const staleAllowlistEntries = Object.entries(config.allowlist)
  .filter(([path]) => {
    const absolutePath = resolve(repoRoot, path);
    return !existsSync(absolutePath) || countLines(absolutePath) <= config.hardLineCount;
  })
  .map(([path]) => path)
  .sort();

const report = {
  scope: config.scope,
  targetLineCount: config.targetLineCount,
  hardLineCount: config.hardLineCount,
  changedFrom,
  scannedFiles: scannedFiles.length,
  overTarget: overTarget.length,
  oversized: oversized.length,
  violations: violations.map((file) => ({
    file: file.path,
    lines: file.lines,
    maxLines: config.allowlist[file.path]?.maxLines ?? null,
    followUp: config.allowlist[file.path]?.followUp ?? 'missing allowlist entry',
  })),
  staleAllowlistEntries,
  topOversized: oversized.slice(0, 25).map((file) => ({
    file: file.path,
    lines: file.lines,
    maxLines: config.allowlist[file.path]?.maxLines ?? null,
    followUp: config.allowlist[file.path]?.followUp ?? 'missing allowlist entry',
  })),
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
