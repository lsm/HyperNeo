import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE_SCHEMA_VERSION = 1;

export type FileLineHits = Map<number, number>;
export type MergedFiles = Map<string, FileLineHits>;

export interface PackageCoverage {
  covered: number;
  total: number;
  percent: number;
}

export interface CoverageStats {
  files: number;
  covered: number;
  total: number;
  percent: number;
  packages: Map<string, PackageCoverage>;
  excludedRecords: number;
}

export interface CoverageBaseline {
  schemaVersion: number;
  overallPercent: number;
  packages: Record<string, PackageCoverage>;
  sourceCommit?: string;
  generatedAt?: string;
}

export interface GateOptions {
  minCoverage: number;
  maxRegression: number;
}

export interface GateResult {
  ok: boolean;
  failures: string[];
  deltaPercent: number | null;
}

export interface MergeInputStats {
  artifactFiles: number;
  excludedRecords: number;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeSfPath(sf: string): string | null {
  let path = sf.trim();
  if (path.startsWith('./')) {
    path = path.slice(2);
  }
  if (path.startsWith('../')) {
    return null;
  }
  if (path.startsWith('/')) {
    const marker = '/packages/';
    const idx = path.lastIndexOf(marker);
    if (idx === -1) {
      return null;
    }
    path = path.slice(idx + 1);
  }
  return path;
}

export function isCountedPath(sf: string): boolean {
  return /^packages\/[^/]+\/src\//.test(sf);
}

export function mergeLcovText(merged: MergedFiles, text: string): number {
  let currentFile: string | null = null;
  let currentHits: FileLineHits | null = null;
  let excludedRecords = 0;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('SF:')) {
      const normalized = normalizeSfPath(line.slice(3));
      if (normalized !== null && isCountedPath(normalized)) {
        currentFile = normalized;
        currentHits = merged.get(currentFile);
        if (!currentHits) {
          currentHits = new Map();
          merged.set(currentFile, currentHits);
        }
      } else {
        currentFile = null;
        currentHits = null;
        excludedRecords += 1;
      }
    } else if (currentHits !== null && currentFile !== null && line.startsWith('DA:')) {
      const firstComma = line.indexOf(',', 3);
      if (firstComma === -1) {
        continue;
      }
      const lineNo = Number.parseInt(line.slice(3, firstComma), 10);
      const secondComma = line.indexOf(',', firstComma + 1);
      const hitsRaw =
        secondComma === -1 ? line.slice(firstComma + 1) : line.slice(firstComma + 1, secondComma);
      const hits = Number.parseInt(hitsRaw, 10);
      if (!Number.isFinite(lineNo) || !Number.isFinite(hits)) {
        continue;
      }
      currentHits.set(lineNo, Math.max(currentHits.get(lineNo) ?? 0, hits));
    } else if (line.startsWith('end_of_record')) {
      currentFile = null;
      currentHits = null;
    }
  }
  return excludedRecords;
}

export function computeStats(merged: MergedFiles, excludedRecords: number): CoverageStats {
  let covered = 0;
  let total = 0;
  const packages = new Map<string, PackageCoverage>();

  for (const [sf, hits] of merged) {
    let fileCovered = 0;
    for (const hitCount of hits.values()) {
      if (hitCount > 0) {
        fileCovered += 1;
      }
    }
    covered += fileCovered;
    total += hits.size;

    const pkg = sf.split('/')[1];
    const entry = packages.get(pkg) ?? { covered: 0, total: 0, percent: 0 };
    entry.covered += fileCovered;
    entry.total += hits.size;
    packages.set(pkg, entry);
  }

  for (const entry of packages.values()) {
    entry.percent = entry.total > 0 ? round2((entry.covered / entry.total) * 100) : 0;
  }

  return {
    files: merged.size,
    covered,
    total,
    percent: total > 0 ? (covered / total) * 100 : 0,
    packages,
    excludedRecords,
  };
}

export function parseBaseline(text: string): CoverageBaseline | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as CoverageBaseline).schemaVersion === BASELINE_SCHEMA_VERSION &&
    typeof (parsed as CoverageBaseline).overallPercent === 'number' &&
    typeof (parsed as CoverageBaseline).packages === 'object' &&
    (parsed as CoverageBaseline).packages !== null
  ) {
    return parsed as CoverageBaseline;
  }
  return null;
}

export function buildBaseline(
  stats: CoverageStats,
  sourceCommit: string | undefined,
  generatedAt: string
): CoverageBaseline {
  const packages: Record<string, PackageCoverage> = {};
  for (const name of [...stats.packages.keys()].sort()) {
    const entry = stats.packages.get(name);
    if (!entry) {
      continue;
    }
    packages[name] = {
      covered: entry.covered,
      total: entry.total,
      percent: round2(entry.percent),
    };
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    overallPercent: round2(stats.percent),
    packages,
    ...(sourceCommit ? { sourceCommit } : {}),
    generatedAt,
  };
}

export function evaluateGate(
  stats: CoverageStats,
  baseline: CoverageBaseline | null,
  options: GateOptions
): GateResult {
  const failures: string[] = [];

  if (stats.total === 0) {
    failures.push(
      'merged coverage contains no counted records under packages/*/src — refusing to pass an empty gate'
    );
  }
  if (stats.percent < options.minCoverage) {
    failures.push(
      `overall coverage ${round2(stats.percent)}% is below the minimum ${options.minCoverage}%`
    );
  }

  let deltaPercent: number | null = null;
  if (!baseline) {
    failures.push(
      'coverage baseline missing or unreadable — cannot evaluate the regression threshold (bootstrap with --write-baseline)'
    );
  } else {
    deltaPercent = round2(stats.percent - baseline.overallPercent);
    if (deltaPercent < options.maxRegression) {
      failures.push(
        `coverage regressed by ${deltaPercent}% relative to baseline ${baseline.overallPercent}% (max allowed regression: ${options.maxRegression}%)`
      );
    }
  }

  return { ok: failures.length === 0, failures, deltaPercent };
}

export function renderSummary(
  stats: CoverageStats,
  baseline: CoverageBaseline | null,
  gate: GateResult,
  input: MergeInputStats
): string {
  const lines: string[] = [];
  lines.push('## Coverage gate (local lcov merge)');
  lines.push('');
  lines.push(
    `Merged ${input.artifactFiles} lcov artifacts into ${stats.files} source files under \`packages/*/src\` (${input.excludedRecords} non-source records excluded).`
  );
  lines.push('');
  lines.push(`Overall: **${round2(stats.percent)}%** (${stats.covered}/${stats.total} lines)`);
  if (baseline) {
    const delta = gate.deltaPercent ?? 0;
    const sign = delta > 0 ? '+' : '';
    lines.push(`Baseline: ${baseline.overallPercent}% — change: ${sign}${delta}%`);
  } else {
    lines.push('Baseline: _missing_');
  }
  lines.push('');
  lines.push('| Package | Covered | Total | Coverage | Δ vs baseline |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const name of [...stats.packages.keys()].sort()) {
    const entry = stats.packages.get(name);
    if (!entry) {
      continue;
    }
    const base = baseline?.packages[name];
    let deltaCell = '—';
    if (base) {
      const delta = round2(entry.percent - base.percent);
      deltaCell = delta > 0 ? `+${delta}%` : `${delta}%`;
    }
    lines.push(
      `| ${name} | ${entry.covered} | ${entry.total} | ${entry.percent}% | ${deltaCell} |`
    );
  }
  lines.push('');
  if (gate.ok) {
    lines.push('✅ Coverage gate passed.');
  } else {
    lines.push('❌ Coverage gate failed:');
    for (const failure of gate.failures) {
      lines.push(`- ${failure}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function findLcovFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.info'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

interface CliOptions {
  artifactsDir: string;
  baselinePath: string;
  minCoverage: number;
  maxRegression: number;
  writeBaseline: boolean;
  sourceCommit?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    artifactsDir: '',
    baselinePath: 'coverage-baseline.json',
    minCoverage: 30,
    maxRegression: -2,
    writeBaseline: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--artifacts') {
      options.artifactsDir = value ?? '';
      index += 1;
    } else if (arg === '--baseline') {
      options.baselinePath = value ?? '';
      index += 1;
    } else if (arg === '--min-coverage') {
      options.minCoverage = Number.parseFloat(value ?? '');
      index += 1;
    } else if (arg === '--max-regression') {
      options.maxRegression = Number.parseFloat(value ?? '');
      index += 1;
    } else if (arg === '--source-commit') {
      options.sourceCommit = value;
      index += 1;
    } else if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else {
      throw new Error(`unknown coverage-gate arg: ${arg}`);
    }
  }

  if (!options.artifactsDir) {
    throw new Error('coverage-gate requires --artifacts <dir>');
  }
  if (!Number.isFinite(options.minCoverage) || !Number.isFinite(options.maxRegression)) {
    throw new Error('--min-coverage and --max-regression require numeric values');
  }
  return options;
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);

  const lcovFiles = findLcovFiles(options.artifactsDir);
  if (lcovFiles.length === 0) {
    console.error(`No lcov (.info) files found under ${options.artifactsDir}`);
    console.error('Expected downloaded lcov-* workflow artifacts — refusing to pass an empty gate');
    return 1;
  }

  const merged: MergedFiles = new Map();
  let excludedRecords = 0;
  for (const file of lcovFiles) {
    excludedRecords += mergeLcovText(merged, readFileSync(file, 'utf8'));
  }

  const stats = computeStats(merged, excludedRecords);
  console.log(
    `Merged ${lcovFiles.length} lcov artifacts: ${stats.files} files, ${stats.covered}/${stats.total} lines covered`
  );

  if (options.writeBaseline) {
    const baseline = buildBaseline(stats, options.sourceCommit, new Date().toISOString());
    writeFileSync(options.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote coverage baseline to ${options.baselinePath}`);
    return 0;
  }

  const baselineText = existsSync(options.baselinePath)
    ? readFileSync(options.baselinePath, 'utf8')
    : null;
  const baseline = baselineText !== null ? parseBaseline(baselineText) : null;
  if (baselineText !== null && baseline === null) {
    console.error(`Coverage baseline at ${options.baselinePath} is not a valid baseline document`);
  }

  const gate = evaluateGate(stats, baseline, {
    minCoverage: options.minCoverage,
    maxRegression: options.maxRegression,
  });
  const summary = renderSummary(stats, baseline, gate, {
    artifactFiles: lcovFiles.length,
    excludedRecords,
  });

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  if (!gate.ok) {
    console.error('Coverage gate FAILED');
    return 1;
  }
  console.log('Coverage gate passed');
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
