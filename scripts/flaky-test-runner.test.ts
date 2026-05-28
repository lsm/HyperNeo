import { describe, expect, it } from 'bun:test';
import {
  type FailedTestCase,
  type FlakyRegistry,
  matchKnownFlakyFailures,
  parseJUnitFailures,
  shouldQuarantine,
  validateRegistry,
} from './flaky-test-runner';

const registry: FlakyRegistry = {
  schemaVersion: 1,
  policy: {
    maxRetries: 2,
    quarantineAfterFailures: 3,
    createFixTaskAfterQuarantine: true,
    fixTaskLabel: 'flaky-test',
  },
  tests: [
    {
      id: 'space-goals',
      suite: 'web',
      path: 'packages/web/src/components/space/__tests__/SpaceGoals.test.tsx',
      namePattern: 'SpaceGoals',
      reason: 'known flaky',
      addedAt: '2026-05-28',
    },
  ],
};

describe('flaky test runner registry policy', () => {
  it('parses failing JUnit testcases', () => {
    const failures = parseJUnitFailures(`<?xml version="1.0"?>
<testsuites tests="1" failures="1">
  <testsuite>
    <testcase name="SpaceGoals &quot;renders cards&quot;" file="packages/web/src/components/space/__tests__/SpaceGoals.test.tsx">
      <failure message="expected element"></failure>
    </testcase>
  </testsuite>
</testsuites>`);

    expect(failures).toEqual([
      {
        file: 'packages/web/src/components/space/__tests__/SpaceGoals.test.tsx',
        name: 'SpaceGoals "renders cards"',
      },
    ]);
  });

  it('falls back to classname when JUnit testcases omit file attributes', () => {
    const failures = parseJUnitFailures(`<?xml version="1.0"?>
<testsuites tests="1" failures="1">
  <testsuite>
    <testcase name="SpaceGoals renders cards" classname="packages/web/src/components/space/__tests__/SpaceGoals.test.tsx">
      <failure message="expected element"></failure>
    </testcase>
  </testsuite>
</testsuites>`);

    expect(failures[0]).toEqual({
      file: 'packages/web/src/components/space/__tests__/SpaceGoals.test.tsx',
      name: 'SpaceGoals renders cards',
    });
  });

  it('separates registered flaky failures from unrelated failures', () => {
    const failures: FailedTestCase[] = [
      {
        file: 'packages/web/src/components/space/__tests__/SpaceGoals.test.tsx',
        name: 'SpaceGoals renders cards',
      },
      {
        file: 'packages/web/src/components/Other.test.tsx',
        name: 'Other fails',
      },
    ];

    const result = matchKnownFlakyFailures(failures, registry, 'web');

    expect(result.known.map((entry) => entry.id)).toEqual(['space-goals']);
    expect(result.unknown).toEqual([failures[1]]);
  });

  it('treats namePattern as literal text instead of a regular expression', () => {
    const literalRegistry: FlakyRegistry = {
      ...registry,
      tests: [{ ...registry.tests[0], id: 'literal', namePattern: 'SpaceGoals [dialog]' }],
    };

    const result = matchKnownFlakyFailures(
      [
        {
          file: 'packages/web/src/components/space/__tests__/SpaceGoals.test.tsx',
          name: 'SpaceGoals [dialog] opens',
        },
      ],
      literalRegistry,
      'web'
    );

    expect(result.known.map((entry) => entry.id)).toEqual(['literal']);
  });

  it('quarantines only after policy threshold is reached', () => {
    expect(shouldQuarantine(2, registry.policy)).toBe(false);
    expect(shouldQuarantine(3, registry.policy)).toBe(true);
  });

  it('validates registry uniqueness and existing registered files', () => {
    expect(() => validateRegistry(registry)).not.toThrow();

    expect(() =>
      validateRegistry({
        ...registry,
        tests: [registry.tests[0], registry.tests[0]],
      })
    ).toThrow('duplicate flaky test id: space-goals');
  });
});
