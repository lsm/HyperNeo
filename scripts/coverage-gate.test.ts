import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  type CoverageBaseline,
  type CoverageStats,
  type MergedFiles,
  buildBaseline,
  computeStats,
  evaluateGate,
  isCountedPath,
  main,
  mergeLcovText,
  normalizeSfPath,
  parseBaseline,
  renderSummary,
} from './coverage-gate';

function statsFixture(overrides: Partial<CoverageStats> = {}): CoverageStats {
  const packages = new Map([['daemon', { covered: 80, total: 100, percent: 80 }]]);
  return {
    files: 10,
    covered: 80,
    total: 100,
    percent: 80,
    packages,
    excludedRecords: 0,
    ...overrides,
  };
}

function baselineFixture(overrides: Partial<CoverageBaseline> = {}): CoverageBaseline {
  return {
    schemaVersion: 1,
    overallPercent: 80,
    packages: { daemon: { covered: 80, total: 100, percent: 80 } },
    ...overrides,
  };
}

describe('normalizeSfPath', () => {
  it('keeps repo-root-relative paths and strips ./ prefix', () => {
    expect(normalizeSfPath('packages/daemon/src/app.ts')).toBe('packages/daemon/src/app.ts');
    expect(normalizeSfPath('./packages/web/src/x.ts')).toBe('packages/web/src/x.ts');
    expect(normalizeSfPath('  packages/shared/src/mod.ts  ')).toBe('packages/shared/src/mod.ts');
  });

  it('relativizes absolute runner paths containing /packages/', () => {
    expect(normalizeSfPath('/home/runner/work/HyperNeo/HyperNeo/packages/daemon/src/main.ts')).toBe(
      'packages/daemon/src/main.ts'
    );
  });

  it('rejects cross-package leftovers and outside-repo absolute paths', () => {
    expect(normalizeSfPath('../ui/src/button.tsx')).toBeNull();
    expect(normalizeSfPath('/usr/lib/something.ts')).toBeNull();
  });
});

describe('isCountedPath', () => {
  it('counts only packages/<pkg>/src paths', () => {
    expect(isCountedPath('packages/daemon/src/lib/app.ts')).toBeTrue();
    expect(isCountedPath('packages/web/src/components/x.tsx')).toBeTrue();
    expect(isCountedPath('tests/unit/helper.ts')).toBeFalse();
    expect(isCountedPath('packages/daemon/tests/unit/helper.ts')).toBeFalse();
    expect(isCountedPath('packages/daemon/scripts/tool.ts')).toBeFalse();
    expect(isCountedPath('src/lib/app.ts')).toBeFalse();
  });
});

describe('mergeLcovText', () => {
  it('parses DA records and unions overlapping flags by max hits', () => {
    const merged: MergedFiles = new Map();
    const unit = [
      'SF:packages/daemon/src/a.ts',
      'DA:1,0',
      'DA:2,5',
      'DA:3,1',
      'end_of_record',
    ].join('\n');
    const online = ['SF:packages/daemon/src/a.ts', 'DA:2,2', 'DA:4,7', 'end_of_record'].join('\n');

    mergeLcovText(merged, unit);
    mergeLcovText(merged, online);

    const hits = merged.get('packages/daemon/src/a.ts');
    expect(hits).toEqual(
      new Map([
        [1, 0],
        [2, 5],
        [3, 1],
        [4, 7],
      ])
    );
  });

  it('handles CRLF line endings and DA checksum fields', () => {
    const merged: MergedFiles = new Map();
    mergeLcovText(
      merged,
      ['SF:packages/web/src/a.tsx', 'DA:7,3,abc123', 'DA:8,0,def456', 'end_of_record'].join('\r\n')
    );
    expect(merged.get('packages/web/src/a.tsx')).toEqual(
      new Map([
        [7, 3],
        [8, 0],
      ])
    );
  });

  it('ignores DA lines outside a record and counts excluded records', () => {
    const merged: MergedFiles = new Map();
    const excluded = mergeLcovText(
      merged,
      [
        'DA:1,9',
        'SF:tests/unit/helper.ts',
        'DA:1,4',
        'end_of_record',
        'SF:../ui/src/button.tsx',
        'DA:2,4',
        'end_of_record',
        'SF:packages/shared/src/mod.ts',
        'DA:10,2',
        'end_of_record',
      ].join('\n')
    );
    expect(excluded).toBe(2);
    expect(merged.size).toBe(1);
    expect(merged.has('packages/shared/src/mod.ts')).toBeTrue();
  });

  it('takes the max for duplicate lines within one file', () => {
    const merged: MergedFiles = new Map();
    mergeLcovText(
      merged,
      ['SF:packages/daemon/src/a.ts', 'DA:5,1', 'DA:5,9', 'DA:5,3', 'end_of_record'].join('\n')
    );
    expect(merged.get('packages/daemon/src/a.ts')?.get(5)).toBe(9);
  });
});

describe('computeStats', () => {
  it('aggregates overall and per-package numbers', () => {
    const merged: MergedFiles = new Map();
    mergeLcovText(
      merged,
      [
        'SF:packages/daemon/src/a.ts',
        'DA:1,1',
        'DA:2,0',
        'end_of_record',
        'SF:packages/daemon/src/b.ts',
        'DA:1,4',
        'end_of_record',
        'SF:packages/web/src/c.tsx',
        'DA:1,0',
        'end_of_record',
      ].join('\n')
    );
    const stats = computeStats(merged, 3);
    expect(stats.files).toBe(3);
    expect(stats.covered).toBe(2);
    expect(stats.total).toBe(4);
    expect(stats.percent).toBe(50);
    expect(stats.excludedRecords).toBe(3);
    expect(stats.packages.get('daemon')).toEqual({ covered: 2, total: 3, percent: 66.67 });
    expect(stats.packages.get('web')).toEqual({ covered: 0, total: 1, percent: 0 });
  });

  it('returns zeroed stats for empty input', () => {
    const stats = computeStats(new Map(), 0);
    expect(stats.total).toBe(0);
    expect(stats.percent).toBe(0);
    expect(stats.packages.size).toBe(0);
  });
});

describe('evaluateGate', () => {
  const options = { minCoverage: 30, maxRegression: -2 };

  it('passes when above minimum and within regression budget', () => {
    const result = evaluateGate(statsFixture(), baselineFixture(), options);
    expect(result.ok).toBeTrue();
    expect(result.deltaPercent).toBe(0);
  });

  it('fails when overall coverage is below the minimum', () => {
    const result = evaluateGate(statsFixture({ percent: 29.9 }), baselineFixture(), options);
    expect(result.ok).toBeFalse();
    expect(result.failures[0]).toContain('below the minimum 30%');
  });

  it('fails when the regression exceeds the budget', () => {
    const result = evaluateGate(statsFixture({ percent: 77.9 }), baselineFixture(), options);
    expect(result.ok).toBeFalse();
    expect(result.failures.join(' ')).toContain('regressed by -2.1%');
  });

  it('passes at exactly the allowed regression boundary', () => {
    const result = evaluateGate(statsFixture({ percent: 78 }), baselineFixture(), options);
    expect(result.ok).toBeTrue();
    expect(result.deltaPercent).toBe(-2);
  });

  it('fails loudly when the baseline is missing or invalid', () => {
    const result = evaluateGate(statsFixture(), null, options);
    expect(result.ok).toBeFalse();
    expect(result.failures.join(' ')).toContain('baseline missing or unreadable');
    expect(result.deltaPercent).toBeNull();
  });

  it('fails when the merge produced no counted records', () => {
    const result = evaluateGate(statsFixture({ total: 0, percent: 0 }), baselineFixture(), options);
    expect(result.ok).toBeFalse();
    expect(result.failures.join(' ')).toContain('no counted records');
  });
});

describe('parseBaseline and buildBaseline', () => {
  it('round-trips a baseline document', () => {
    const baseline = buildBaseline(statsFixture(), 'abc123', '2026-08-21T00:00:00Z');
    const parsed = parseBaseline(JSON.stringify(baseline));
    expect(parsed).toEqual(baseline);
    expect(parsed?.sourceCommit).toBe('abc123');
  });

  it('rejects malformed or wrong-schema documents', () => {
    expect(parseBaseline('not json')).toBeNull();
    expect(parseBaseline('{"overallPercent": 50}')).toBeNull();
    expect(
      parseBaseline('{"schemaVersion": 1, "overallPercent": 50, "packages": null}')
    ).toBeNull();
    expect(
      parseBaseline(JSON.stringify({ schemaVersion: 2, overallPercent: 50, packages: {} }))
    ).toBeNull();
  });

  it('sorts packages and rounds stored percentages', () => {
    const packages = new Map([
      ['web', { covered: 1, total: 3, percent: 33.333 }],
      ['daemon', { covered: 2, total: 3, percent: 66.666 }],
    ]);
    const baseline = buildBaseline(
      statsFixture({ percent: 83.525, packages }),
      undefined,
      '2026-08-21T00:00:00Z'
    );
    expect(Object.keys(baseline.packages)).toEqual(['daemon', 'web']);
    expect(baseline.overallPercent).toBe(83.53);
    expect(baseline.packages.web?.percent).toBe(33.33);
    expect(baseline.sourceCommit).toBeUndefined();
  });
});

describe('renderSummary', () => {
  it('renders overall, per-package rows, and failure reasons', () => {
    const gate = evaluateGate(statsFixture({ percent: 20 }), baselineFixture(), {
      minCoverage: 30,
      maxRegression: -2,
    });
    const summary = renderSummary(statsFixture({ percent: 20 }), baselineFixture(), gate, {
      artifactFiles: 4,
      excludedRecords: 2,
    });
    expect(summary).toContain('Merged 4 lcov artifacts into 10 source files');
    expect(summary).toContain('**20%** (80/100 lines)');
    expect(summary).toContain('Baseline: 80% — change: -60%');
    expect(summary).toContain('| daemon | 80 | 100 | 80% | 0% |');
    expect(summary).toContain('❌ Coverage gate failed:');
    expect(summary).toContain('below the minimum 30%');
  });

  it('renders a pass line when the gate succeeds', () => {
    const gate = evaluateGate(statsFixture(), baselineFixture(), {
      minCoverage: 30,
      maxRegression: -2,
    });
    const summary = renderSummary(statsFixture(), baselineFixture(), gate, {
      artifactFiles: 1,
      excludedRecords: 0,
    });
    expect(summary).toContain('✅ Coverage gate passed.');
  });
});

describe('main', () => {
  it('gates against a baseline file and exits nonzero on violation', () => {
    const artifactsDir = `/tmp/coverage-gate-test-${process.pid}`;
    const baselinePath = `${artifactsDir}/baseline.json`;
    mkdirSync(`${artifactsDir}/a`, { recursive: true });
    writeFileSync(
      `${artifactsDir}/a/lcov.info`,
      ['SF:packages/daemon/src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join('\n')
    );
    writeFileSync(
      baselinePath,
      JSON.stringify({
        schemaVersion: 1,
        overallPercent: 99,
        packages: { daemon: { covered: 2, total: 2, percent: 100 } },
      })
    );

    expect(main(['--artifacts', artifactsDir, '--baseline', baselinePath])).toBe(1);

    writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 1, overallPercent: 50, packages: {} })
    );
    expect(main(['--artifacts', artifactsDir, '--baseline', baselinePath])).toBe(0);
  });

  it('writes a baseline document in --write-baseline mode without gating', async () => {
    const artifactsDir = `/tmp/coverage-gate-test-write-${process.pid}`;
    const baselinePath = `${artifactsDir}/baseline.json`;
    mkdirSync(`${artifactsDir}/a`, { recursive: true });
    writeFileSync(
      `${artifactsDir}/a/lcov.info`,
      ['SF:packages/daemon/src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join('\n')
    );

    expect(
      main(['--artifacts', artifactsDir, '--baseline', baselinePath, '--write-baseline'])
    ).toBe(0);
    const baseline = parseBaseline(await Bun.file(baselinePath).text());
    expect(baseline?.overallPercent).toBe(50);
    expect(baseline?.packages.daemon).toEqual({ covered: 1, total: 2, percent: 50 });
  });

  it('fails when no lcov artifacts are present', () => {
    const artifactsDir = `/tmp/coverage-gate-test-empty-${process.pid}`;
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(`${artifactsDir}/keep.txt`, 'x');
    expect(main(['--artifacts', artifactsDir])).toBe(1);
  });
});
