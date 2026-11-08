import { expect, test } from 'bun:test';
import { compareTestTypes, countTscErrors } from './check-test-types.ts';

test('countTscErrors counts errors per file and ignores continuation lines', () => {
  const output = [
    'packages/daemon/tests/a.test.ts(3,9): error TS2769: No overload matches this call.',
    '  The last overload gave the following error.',
    "packages/daemon/tests/a.test.ts(9,1): error TS2345: Argument of type 'x' is not assignable.",
    "packages/web/src/lib/b.ts(1,2): error TS7006: Parameter 't' implicitly has an 'any' type.",
    '',
  ].join('\n');
  expect(countTscErrors(output)).toEqual({
    'packages/daemon/tests/a.test.ts': 2,
    'packages/web/src/lib/b.ts': 1,
  });
});

test('compareTestTypes fails a regression and a new file but passes an unchanged count', () => {
  expect(compareTestTypes({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual({ failed: false, lines: [] });
  expect(compareTestTypes({ 'a.ts': 2 }, { 'a.ts': 3, 'b.ts': 1 })).toEqual({
    failed: true,
    lines: ['REGRESSION a.ts: 2 -> 3', 'REGRESSION b.ts: 0 -> 1'],
  });
});

test('compareTestTypes fails a stale baseline so counts can only go down', () => {
  expect(compareTestTypes({ 'a.ts': 2, 'b.ts': 1 }, { 'a.ts': 1 })).toEqual({
    failed: true,
    lines: [
      'STALE BASELINE a.ts: 2 -> 1 (commit the tightened baseline with --write-baseline)',
      'STALE BASELINE b.ts: 1 -> 0 (commit the tightened baseline with --write-baseline)',
    ],
  });
});
