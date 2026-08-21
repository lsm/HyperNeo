import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMeasuredFromJunit,
  listSplitSpecs,
  main,
  mergeManifest,
  parseManifest,
  renderManifest,
} from './generate-shard-weights';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'generate-shard-weights-test-'));
  tempDirs.push(dir);
  return dir;
}

function junitXml(suites: { name: string; time: number; tests: number }[]): string {
  const total = suites.reduce((sum, suite) => sum + suite.tests, 0);
  const time = suites.reduce((sum, suite) => sum + suite.time, 0);
  const body = suites
    .map(
      (suite) =>
        `  <testsuite name="${suite.name}" tests="${suite.tests}" failures="0" errors="0" skipped="0" time="${suite.time}"></testsuite>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="${total}" failures="0" errors="0" time="${time}">
${body}
</testsuites>
`;
}

describe('parseManifest', () => {
  it('parses weight lines and skips comments and blanks', () => {
    const parsed = parseManifest(
      '# header\n\n123\tpackages/daemon/tests/unit/a.test.ts\n456\tpackages/daemon/tests/unit/b.test.ts\n'
    );

    expect(parsed.errors).toEqual([]);
    expect([...parsed.entries.entries()]).toEqual([
      ['packages/daemon/tests/unit/a.test.ts', 123],
      ['packages/daemon/tests/unit/b.test.ts', 456],
    ]);
  });

  it('rejects malformed lines, bad weights, extra columns, and duplicates', () => {
    const parsed = parseManifest(
      [
        'no-tab-here',
        '12.5\tpackages/daemon/tests/unit/a.test.ts',
        '-5\tpackages/daemon/tests/unit/a.test.ts',
        '10\tpackages/daemon/tests/unit/b.test.ts\textra',
        '20\t',
        '30\tpackages/daemon/tests/unit/a.test.ts',
        '30\tpackages/daemon/tests/unit/a.test.ts',
      ].join('\n')
    );

    expect(parsed.entries.get('packages/daemon/tests/unit/a.test.ts')).toBe(30);
    expect(parsed.errors).toHaveLength(6);
  });
});

describe('renderManifest', () => {
  it('renders a sorted manifest that round-trips through parseManifest', () => {
    const entries = new Map([
      ['packages/daemon/tests/unit/z.test.ts', 200],
      ['packages/daemon/tests/unit/a.test.ts', 100],
    ]);
    const rendered = renderManifest(entries);

    expect(rendered.startsWith('# shard-weights manifest')).toBe(true);
    expect(rendered).toContain(
      '100\tpackages/daemon/tests/unit/a.test.ts\n200\tpackages/daemon/tests/unit/z.test.ts\n'
    );
    const parsed = parseManifest(rendered);
    expect(parsed.errors).toEqual([]);
    expect([...parsed.entries.entries()]).toEqual([
      ['packages/daemon/tests/unit/a.test.ts', 100],
      ['packages/daemon/tests/unit/z.test.ts', 200],
    ]);
  });
});

describe('mergeManifest', () => {
  const existing = new Map([
    ['kept.test.ts', 100],
    ['overridden.test.ts', 100],
    ['unrelated.test.ts', 100],
    ['deleted.test.ts', 100],
  ]);
  const measured = new Map([
    ['overridden.test.ts', 999],
    ['outside-coverage.test.ts', 500],
  ]);
  const covered = new Set(['kept.test.ts', 'overridden.test.ts', 'brand-new.test.ts']);

  it('overrides measured covered files, keeps unmeasured ones, drops stale, ignores the rest', () => {
    const merge = mergeManifest({
      existing,
      measured,
      covered,
      exists: (path) => path !== 'deleted.test.ts',
    });

    expect(merge.merged.get('overridden.test.ts')).toBe(999);
    expect(merge.merged.get('kept.test.ts')).toBe(100);
    expect(merge.merged.get('unrelated.test.ts')).toBe(100);
    expect(merge.merged.has('deleted.test.ts')).toBe(false);
    expect(merge.merged.has('outside-coverage.test.ts')).toBe(false);
    expect(merge.merged.has('brand-new.test.ts')).toBe(false);
    expect(merge.updated).toEqual(['overridden.test.ts']);
    expect(merge.kept).toEqual(['kept.test.ts']);
    expect(merge.staleDropped).toEqual(['deleted.test.ts']);
  });
});

describe('buildMeasuredFromJunit', () => {
  it('maps junit suites to repo paths as rounded milliseconds, keeping the max across runs', () => {
    const { measured, unresolved } = buildMeasuredFromJunit([
      {
        path: 'junit-a.xml',
        xml: junitXml([
          {
            name: 'tests/unit/5-space/runtime/agent-message-routing-gates.test.ts',
            time: 1.234,
            tests: 2,
          },
          { name: 'nowhere/x.test.ts', time: 9, tests: 1 },
        ]),
      },
      {
        path: 'junit-b.xml',
        xml: junitXml([
          {
            name: 'tests/unit/5-space/runtime/agent-message-routing-gates.test.ts',
            time: 2.5,
            tests: 1,
          },
        ]),
      },
    ]);

    expect(
      measured.get('packages/daemon/tests/unit/5-space/runtime/agent-message-routing-gates.test.ts')
    ).toBe(2500);
    expect(unresolved).toEqual(['nowhere/x.test.ts']);
  });
});

describe('listSplitSpecs', () => {
  it('reads the real split table: weighted 5-space-runtime and hash-only 1-core', () => {
    const specs = listSplitSpecs('daemon-unit');
    const runtime = specs.find((spec) => spec.prefix === '5-space-runtime');

    expect(runtime).toBeDefined();
    expect(runtime?.splitCount).toBe(7);
    expect(runtime?.weights).toBe('scripts/shard-weights.tsv');
    expect(runtime?.testRoot).toBe('packages/daemon/tests/unit');
    expect(runtime?.globs).toContain('5-space/runtime/*.test.ts');
    expect(runtime?.files.length).toBeGreaterThan(10);
    for (const file of runtime?.files ?? []) {
      expect(file.startsWith('packages/daemon/tests/unit/5-space/runtime/')).toBe(true);
    }

    const core = specs.find((spec) => spec.prefix === '1-core');
    expect(core?.weights).toBeNull();

    const online = listSplitSpecs('daemon-online');
    expect(online.map((spec) => spec.prefix)).toContain('rpc');
    expect(online.every((spec) => spec.testRoot === 'packages/daemon/tests/online')).toBe(true);
  }, 30000);
});

describe('main', () => {
  it('dry-runs end to end against the real spec table without writing the repo manifest', () => {
    const dir = makeTempDir();
    const junitPath = join(dir, 'junit-5-space-runtime-a.xml');
    writeFileSync(
      junitPath,
      junitXml([
        {
          name: 'tests/unit/5-space/runtime/agent-message-routing-gates.test.ts',
          time: 4.0,
          tests: 3,
        },
      ])
    );
    const outPath = join(dir, 'shard-weights.tsv');
    const out: string[] = [];
    const warn: string[] = [];
    const code = main(['--suite', 'daemon-unit', '--dry-run', '--out', outPath, junitPath], {
      out: (line) => out.push(line),
      warn: (line) => warn.push(line),
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toContain(
      `would write ${outPath}: 1 entry (1 updated, 0 kept, 0 stale-dropped)`
    );
    expect(out.join('\n')).toMatch(
      /preview 5-space-runtime 7-way split, \d+ files \(1 weighted, \d+ hash-fallback\)/
    );
    expect(out.join('\n')).toContain('hash today:');
    expect(out.join('\n')).toContain('packed:');
    expect(warn.join('\n')).toContain('references manifest scripts/shard-weights.tsv');
    expect(warn.join('\n')).toContain('hash-fallback');
  }, 30000);

  it('writes the manifest and merges with an existing one', () => {
    const dir = makeTempDir();
    const junitPath = join(dir, 'junit.xml');
    writeFileSync(
      junitPath,
      junitXml([
        {
          name: 'tests/unit/5-space/runtime/agent-message-routing-gates.test.ts',
          time: 4.0,
          tests: 3,
        },
      ])
    );
    const outPath = join(dir, 'shard-weights.tsv');
    writeFileSync(
      outPath,
      '# existing\n777\tpackages/daemon/tests/unit/5-space/runtime/agent-message-routing-gates.test.ts\n500\tpackages/daemon/tests/unit/1-core/core/main-import-order.test.ts\n'
    );
    const out: string[] = [];
    const code = main(['--suite', 'daemon-unit', '--out', outPath, junitPath], {
      out: (line) => out.push(line),
      warn: () => {},
    });

    expect(code).toBe(0);
    const manifest = readFileSync(outPath, 'utf8');
    expect(manifest).toContain(
      '4000\tpackages/daemon/tests/unit/5-space/runtime/agent-message-routing-gates.test.ts'
    );
    expect(manifest).toContain(
      '500\tpackages/daemon/tests/unit/1-core/core/main-import-order.test.ts'
    );
    expect(out.join('\n')).toContain('(1 updated, 0 kept, 0 stale-dropped)');
  }, 30000);

  it('rejects an unknown suite and missing junit inputs', () => {
    expect(main(['--suite', 'nope', 'x.xml'], { out: () => {}, warn: () => {} })).toBe(2);
    expect(main(['--suite', 'daemon-unit'], { out: () => {}, warn: () => {} })).toBe(2);
  });
});
