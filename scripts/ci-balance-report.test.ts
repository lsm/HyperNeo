import { describe, expect, it } from 'bun:test';
import {
  bucketLabelFromPath,
  buildReport,
  parseJunitTimings,
  renderMarkdown,
  resolveSuitePath,
} from './ci-balance-report';

function junitXml(
  suites: { name: string; time: number; tests: number; failures?: number; errors?: number }[]
): string {
  const total = suites.reduce((sum, suite) => sum + suite.tests, 0);
  const time = suites.reduce((sum, suite) => sum + suite.time, 0);
  const failures = suites.reduce((sum, suite) => sum + (suite.failures ?? 0), 0);
  const errors = suites.reduce((sum, suite) => sum + (suite.errors ?? 0), 0);
  const body = suites
    .map(
      (
        suite
      ) => `    <testsuite name="${suite.name}" timestamp="2026-08-21T05:00:00.000Z" hostname="ci" tests="${suite.tests}" failures="${suite.failures ?? 0}" errors="${suite.errors ?? 0}" skipped="0" time="${suite.time}">
        <testcase classname="${suite.name}" name="describe &gt; test" time="${suite.time}"></testcase>
    </testsuite>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="${total}" failures="${failures}" errors="${errors}" time="${time}">
${body}
</testsuites>
`;
}

const twoBucketInput = [
  {
    path: 'test-results/daemon-online-rpc-a/junit-rpc-a.xml',
    xml: junitXml([
      { name: 'tests/online/rpc/rpc-agent-handlers.test.ts', time: 10.5, tests: 4 },
      { name: 'tests/online/rpc/rpc-config-handlers.test.ts', time: 5.5, tests: 2 },
    ]),
  },
  {
    path: 'test-results/daemon-online-rpc-b/junit-rpc-b.xml',
    xml: junitXml([
      { name: 'tests/online/rpc/rpc-draft-handlers.test.ts', time: 20.0, tests: 6, failures: 1 },
      { name: 'tests/online/rpc/rpc-agent-handlers.test.ts', time: 1.0, tests: 1 },
    ]),
  },
];

describe('parseJunitTimings', () => {
  it('parses vitest junit root totals and per-file suites', () => {
    const timings = parseJunitTimings(junitXml([{ name: 'a.test.ts', time: 1.5, tests: 2 }]));

    expect(timings.reported).toEqual({
      name: 'testsuites',
      tests: 2,
      failures: 0,
      errors: 0,
      skipped: 0,
      timeSeconds: 1.5,
    });
    expect(timings.suites).toEqual([
      {
        name: 'a.test.ts',
        tests: 2,
        failures: 0,
        errors: 0,
        skipped: 0,
        timeSeconds: 1.5,
      },
    ]);
  });

  it('treats missing attributes as zero', () => {
    const timings = parseJunitTimings(
      '<testsuites><testsuite name="a.test.ts"></testsuite></testsuites>'
    );

    expect(timings.reported).toEqual({
      name: 'testsuites',
      tests: 0,
      failures: 0,
      errors: 0,
      skipped: 0,
      timeSeconds: 0,
    });
    expect(timings.suites[0]?.timeSeconds).toBe(0);
  });

  it('does not confuse testsuites with testsuite elements', () => {
    const timings = parseJunitTimings(junitXml([{ name: 'a.test.ts', time: 1, tests: 1 }]));

    expect(timings.suites).toHaveLength(1);
  });
});

describe('bucketLabelFromPath', () => {
  it('derives the bucket label from the junit file name', () => {
    expect(bucketLabelFromPath('test-results/daemon/junit-5-space-runtime-a.xml')).toBe(
      '5-space-runtime-a'
    );
    expect(bucketLabelFromPath('test-results/web/junit-web.xml')).toBe('web');
    expect(bucketLabelFromPath('anywhere/adhoc.xml')).toBe('adhoc');
  });

  it('falls back to the parent directory for generic junit.xml names', () => {
    expect(bucketLabelFromPath('test-results/daemon-online-rpc-a/junit.xml')).toBe(
      'daemon-online-rpc-a'
    );
  });
});

describe('resolveSuitePath', () => {
  it('resolves junit paths against the package roots and classifies the suite', () => {
    expect(resolveSuitePath('tests/unit/1-core/core/main-import-order.test.ts')).toEqual({
      repoPath: 'packages/daemon/tests/unit/1-core/core/main-import-order.test.ts',
      suite: 'daemon-unit',
    });
    expect(resolveSuitePath('tests/online/rpc/rpc-agent-handlers.test.ts').suite).toBe(
      'daemon-online'
    );
    expect(resolveSuitePath('src/lib/priority-tokens.test.ts').suite).toBe('web');
  });

  it('reports unknown paths as unresolved', () => {
    expect(resolveSuitePath('tests/does-not-exist.test.ts')).toEqual({
      repoPath: null,
      suite: null,
    });
  });
});

describe('buildReport', () => {
  it('aggregates hand-computed bucket totals and sorts per-file durations', () => {
    const report = buildReport(twoBucketInput, { coverage: false });

    expect(report.buckets).toEqual([
      {
        bucket: 'rpc-b',
        junitPath: 'test-results/daemon-online-rpc-b/junit-rpc-b.xml',
        files: 2,
        tests: 7,
        failures: 1,
        errors: 0,
        skipped: 0,
        timeSeconds: 21.0,
        reportedTimeSeconds: 21.0,
      },
      {
        bucket: 'rpc-a',
        junitPath: 'test-results/daemon-online-rpc-a/junit-rpc-a.xml',
        files: 2,
        tests: 6,
        failures: 0,
        errors: 0,
        skipped: 0,
        timeSeconds: 16.0,
        reportedTimeSeconds: 16.0,
      },
    ]);
    expect(report.files.map((row) => [row.bucket, row.file, row.timeSeconds])).toEqual([
      ['rpc-b', 'tests/online/rpc/rpc-draft-handlers.test.ts', 20.0],
      ['rpc-a', 'tests/online/rpc/rpc-agent-handlers.test.ts', 10.5],
      ['rpc-a', 'tests/online/rpc/rpc-config-handlers.test.ts', 5.5],
      ['rpc-b', 'tests/online/rpc/rpc-agent-handlers.test.ts', 1.0],
    ]);
  });

  it('flags files present in more than one bucket', () => {
    const report = buildReport(twoBucketInput, { coverage: false });

    expect(report.duplicates).toEqual([
      { file: 'tests/online/rpc/rpc-agent-handlers.test.ts', buckets: ['rpc-a', 'rpc-b'] },
    ]);
  });

  it('keeps paths that do not exist on disk as unresolved', () => {
    const report = buildReport([
      {
        path: 'junit-unknown.xml',
        xml: junitXml([{ name: 'nowhere/x.test.ts', time: 1, tests: 1 }]),
      },
    ]);

    expect(report.unresolvedPaths).toEqual([{ bucket: 'unknown', path: 'nowhere/x.test.ts' }]);
  });

  it('diffs run files against the shard-config oracle', () => {
    const report = buildReport([
      {
        path: 'junit-1-core.xml',
        xml: junitXml([
          { name: 'tests/unit/1-core/core/main-import-order.test.ts', time: 1, tests: 1 },
        ]),
      },
    ]);

    const unitCoverage = report.coverage.find((row) => row.suite === 'daemon-unit');
    expect(unitCoverage).toBeDefined();
    expect(unitCoverage?.covered).toBe(1);
    expect(unitCoverage?.expected).toBeGreaterThan(100);
    expect(unitCoverage?.missing).toContain('packages/shared/tests/logger.test.ts');
    expect(report.coverage.map((row) => row.suite)).toEqual(['daemon-unit']);
  }, 30000);

  it('skips the coverage oracle entirely when coverage is disabled', () => {
    const report = buildReport(twoBucketInput, { coverage: false });

    expect(report.coverage).toEqual([]);
    expect(report.coverageNote).toBeNull();
  });

  it('reports a whole-suite empty junit as fully missing via its artifact path', () => {
    const report = buildReport([
      {
        path: 'test-results/web/junit-web.xml',
        xml: '<?xml version="1.0"?>\n<testsuites tests="0" failures="0" errors="0" time="0"></testsuites>\n',
      },
    ]);

    const webCoverage = report.coverage.find((row) => row.suite === 'web');
    expect(webCoverage).toBeDefined();
    expect(webCoverage?.covered).toBe(0);
    expect(webCoverage?.expected).toBeGreaterThan(50);
    expect(webCoverage?.missing[0]).toContain('packages/web/src/');
  });
});

describe('renderMarkdown', () => {
  it('renders bucket totals, spread, and a truncated per-file table', () => {
    const report = buildReport(twoBucketInput, { coverage: false });
    const markdown = renderMarkdown(report, 2);

    expect(markdown).toContain('| rpc-b | 2 | 7 | 21.0s |');
    expect(markdown).toContain('| rpc-a | 2 | 6 | 16.0s |');
    expect(markdown).toContain('spread: slowest rpc-b 21.0s vs fastest rpc-a 16.0s');
    expect(markdown).toContain('## Per-file durations (top 2 of 4)');
    expect(markdown).toContain('packages/daemon/tests/online/rpc/rpc-draft-handlers.test.ts');
    expect(markdown).toContain('1 file(s) reported failures/errors');
  });

  it('renders the oracle-failure note alongside partial coverage rows', () => {
    const report = buildReport(twoBucketInput, { coverage: false });
    report.coverage = [{ suite: 'daemon-unit', expected: 530, covered: 530, missing: [] }];
    report.coverageNote = 'coverage oracle unavailable for: daemon-online: boom';
    const markdown = renderMarkdown(report, 2);

    expect(markdown).toContain('- daemon-unit: 530/530 covered');
    expect(markdown).toContain('coverage oracle unavailable for: daemon-online: boom');
  });
});
