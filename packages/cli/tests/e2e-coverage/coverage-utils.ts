/**
 * E2E Coverage Utilities
 *
 * Shared utilities for collecting both server-side and browser-side coverage
 * during E2E tests with an in-process server.
 */
import { resolve } from 'path';
import type { Page } from 'playwright';
import v8ToIstanbul from 'v8-to-istanbul';

// V8 coverage entry type from Playwright
export type V8CoverageEntry = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number];

/**
 * Coverage collector that accumulates browser-side coverage from multiple pages
 */
export class BrowserCoverageCollector {
  private coverage: V8CoverageEntry[] = [];
  private serverPort: number;

  constructor(serverPort: number) {
    this.serverPort = serverPort;
  }

  /**
   * Start coverage collection on a page
   */
  async startCoverage(page: Page): Promise<void> {
    await page.coverage.startJSCoverage({
      reportAnonymousScripts: false,
      resetOnNavigation: false,
    });
  }

  /**
   * Stop coverage collection and accumulate results
   */
  async stopCoverage(page: Page): Promise<void> {
    const coverage = await page.coverage.stopJSCoverage();

    // Filter to only include app code
    const appCoverage = coverage.filter((entry) => {
      const url = entry.url;
      return (
        url.startsWith(`http://localhost:${this.serverPort}/`) && !url.includes('node_modules')
      );
    });

    this.coverage.push(...appCoverage);
  }

  /**
   * Get all collected coverage entries
   */
  getCoverage(): V8CoverageEntry[] {
    return this.coverage;
  }

  /**
   * Clear collected coverage
   */
  clear(): void {
    this.coverage = [];
  }
}

/**
 * Convert V8 coverage to Istanbul format with source maps
 */
export async function convertToIstanbul(
  coverage: V8CoverageEntry[],
  distPath: string
): Promise<Record<string, unknown>> {
  // Find main bundle
  const mainBundle = coverage.find((e) => e.url.includes('/assets/main-'));
  if (!mainBundle) {
    return {};
  }

  const bundleFileName = mainBundle.url.split('/').pop()!;
  const bundlePath = resolve(distPath, 'assets', bundleFileName);
  const sourceMapPath = `${bundlePath}.map`;

  // Check source map exists
  const hasSourceMap = await Bun.file(sourceMapPath).exists();
  if (!hasSourceMap) {
    console.warn('Source map not found:', sourceMapPath);
    return {};
  }

  // Convert using v8-to-istanbul
  const converter = v8ToIstanbul(bundlePath, 0, { source: mainBundle.source });
  await converter.load();
  converter.applyCoverage(mainBundle.functions);

  return converter.toIstanbul();
}

/**
 * Generate LCOV output from Istanbul coverage
 */
export function generateLcov(
  istanbulCoverage: Record<string, unknown>,
  filterPath: string
): string {
  let lcovContent = '';

  for (const [filePath, data] of Object.entries(istanbulCoverage)) {
    // Skip files not matching filter
    if (!filePath.includes(filterPath)) {
      continue;
    }

    const coverageData = data as {
      fnMap?: Record<string, { name: string; decl: { start: { line: number } } }>;
      f?: Record<string, number>;
      statementMap?: Record<string, { start: { line: number } }>;
      s?: Record<string, number>;
    };

    // Convert absolute path to relative path starting with packages/
    const packagesIndex = filePath.indexOf('packages/');
    const relativePath = packagesIndex >= 0 ? filePath.slice(packagesIndex) : filePath;

    lcovContent += `TN:\n`;
    lcovContent += `SF:${relativePath}\n`;

    // Function coverage
    const fnMap = coverageData.fnMap || {};
    const f = coverageData.f || {};
    for (const [_fnId, fnData] of Object.entries(fnMap)) {
      lcovContent += `FN:${fnData.decl.start.line},${fnData.name || '(anonymous)'}\n`;
    }
    for (const [fnId, count] of Object.entries(f)) {
      lcovContent += `FNDA:${count},${fnMap[fnId]?.name || '(anonymous)'}\n`;
    }
    lcovContent += `FNF:${Object.keys(fnMap).length}\n`;
    lcovContent += `FNH:${Object.values(f).filter((c) => c > 0).length}\n`;

    // Line coverage
    const statementMap = coverageData.statementMap || {};
    const s = coverageData.s || {};
    const lineHits = new Map<number, number>();
    for (const [stmtId, loc] of Object.entries(statementMap)) {
      const line = loc.start.line;
      const count = s[stmtId] || 0;
      lineHits.set(line, Math.max(lineHits.get(line) || 0, count));
    }
    for (const [line, hits] of [...lineHits.entries()].sort((a, b) => a[0] - b[0])) {
      lcovContent += `DA:${line},${hits}\n`;
    }
    lcovContent += `LF:${lineHits.size}\n`;
    lcovContent += `LH:${[...lineHits.values()].filter((h) => h > 0).length}\n`;

    lcovContent += `end_of_record\n`;
  }

  return lcovContent;
}

/**
 * Calculate coverage statistics from Istanbul coverage
 */
export function calculateStats(
  istanbulCoverage: Record<string, unknown>,
  filterPath: string
): {
  totalStatements: number;
  coveredStatements: number;
  files: Map<string, { total: number; covered: number }>;
} {
  const files = new Map<string, { total: number; covered: number }>();
  let totalStatements = 0;
  let coveredStatements = 0;

  for (const [filePath, data] of Object.entries(istanbulCoverage)) {
    if (!filePath.includes(filterPath)) {
      continue;
    }

    const coverageData = data as {
      statementMap?: Record<string, unknown>;
      s?: Record<string, number>;
    };

    const statementMap = coverageData.statementMap || {};
    const s = coverageData.s || {};

    const total = Object.keys(statementMap).length;
    const covered = Object.values(s).filter((count) => count > 0).length;

    const shortPath = filePath.replace(/.*packages\/web\/src\//, 'web/src/');
    files.set(shortPath, { total, covered });
    totalStatements += total;
    coveredStatements += covered;
  }

  return { totalStatements, coveredStatements, files };
}

/**
 * Print coverage summary
 */
export function printCoverageSummary(stats: ReturnType<typeof calculateStats>): void {
  console.log('\n📊 Browser-side Coverage Summary:\n');

  // Sort by path
  const sortedFiles = [...stats.files.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [file, { total, covered }] of sortedFiles) {
    const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : '0.0';
    console.log(`   ${file}: ${pct}% (${covered}/${total} statements)`);
  }

  const totalPct =
    stats.totalStatements > 0
      ? ((stats.coveredStatements / stats.totalStatements) * 100).toFixed(1)
      : '0.0';
  console.log(
    `\n   📈 Total: ${totalPct}% coverage (${stats.coveredStatements}/${stats.totalStatements} statements)\n`
  );
}
