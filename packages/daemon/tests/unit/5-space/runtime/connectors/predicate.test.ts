import { describe, expect, test } from 'bun:test';
import {
  evaluatePredicate,
  getPath,
} from '../../../../../src/lib/space/runtime/connectors/predicate';

describe('predicate.getPath', () => {
  test('dot path into nested object', () => {
    const scope = { a: { b: { c: 1 } } };
    expect(getPath(scope, 'a.b.c')).toBe(1);
  });

  test('array index traversal', () => {
    const scope = { reactions: [{ login: 'x' }, { login: 'y' }] };
    expect(getPath(scope, 'reactions.1.login')).toBe('y');
  });

  test('missing path returns undefined', () => {
    expect(getPath({ a: 1 }, 'b')).toBeUndefined();
    expect(getPath(undefined, 'a')).toBeUndefined();
  });

  test('does not walk the prototype chain (__proto__, constructor)', () => {
    expect(getPath({}, '__proto__')).toBeUndefined();
    expect(getPath({}, 'constructor')).toBeUndefined();
    expect(getPath({}, 'toString')).toBeUndefined();
    expect(getPath({ state: 'OPEN' }, 'state')).toBe('OPEN');
  });

  test('present/empty are not fooled by inherited properties', () => {
    expect(evaluatePredicate({ present: '__proto__' }, {})).toBe(false);
    expect(evaluatePredicate({ empty: '__proto__' }, {})).toBe(true);
  });
});

describe('predicate leaf operators', () => {
  test('eq / neq', () => {
    expect(evaluatePredicate({ eq: ['state', 'OPEN'] }, { state: 'OPEN' })).toBe(true);
    expect(evaluatePredicate({ eq: ['state', 'OPEN'] }, { state: 'CLOSED' })).toBe(false);
    expect(evaluatePredicate({ neq: ['state', 'OPEN'] }, { state: 'CLOSED' })).toBe(true);
  });

  test('in / nin', () => {
    expect(evaluatePredicate({ in: ['x', ['A', 'B']] }, { x: 'B' })).toBe(true);
    expect(evaluatePredicate({ in: ['x', ['A', 'B']] }, { x: 'C' })).toBe(false);
    expect(evaluatePredicate({ nin: ['x', ['A', 'B']] }, { x: 'C' })).toBe(true);
  });

  test('contains is case-insensitive', () => {
    expect(evaluatePredicate({ contains: ['login', 'codex'] }, { login: 'Codex[Bot]' })).toBe(true);
    expect(evaluatePredicate({ contains: ['login', 'codex'] }, { login: 'dependabot' })).toBe(
      false
    );
  });

  test('endswith is case-sensitive', () => {
    expect(evaluatePredicate({ endswith: ['login', '[bot]'] }, { login: 'codex[bot]' })).toBe(true);
    expect(evaluatePredicate({ endswith: ['login', '[bot]'] }, { login: 'codex-fan' })).toBe(false);
  });

  test('gte numeric and lexicographic ISO', () => {
    expect(evaluatePredicate({ gte: ['n', 5] }, { n: 5 })).toBe(true);
    expect(evaluatePredicate({ gte: ['n', 5] }, { n: 4 })).toBe(false);
    expect(
      evaluatePredicate(
        { gte: ['createdAt', '2026-08-02T12:00:00Z'] },
        { createdAt: '2026-08-02T12:00:05Z' }
      )
    ).toBe(true);
    expect(
      evaluatePredicate(
        { lt: ['createdAt', '2026-08-02T12:00:00Z'] },
        { createdAt: '2026-08-02T11:59:59Z' }
      )
    ).toBe(true);
  });

  test('gte on missing field is false', () => {
    expect(evaluatePredicate({ gte: ['missing', 1] }, { other: 2 })).toBe(false);
  });

  test('present / empty / notEmpty', () => {
    expect(evaluatePredicate({ present: 'x' }, { x: 0 })).toBe(true);
    expect(evaluatePredicate({ present: 'x' }, {})).toBe(false);
    expect(evaluatePredicate({ empty: 'list' }, { list: [] })).toBe(true);
    expect(evaluatePredicate({ empty: 'list' }, { list: ['a'] })).toBe(false);
    expect(evaluatePredicate({ notEmpty: 'list' }, { list: ['a'] })).toBe(true);
  });
});

describe('predicate combinators', () => {
  test('all / any / not', () => {
    const all = { all: [{ eq: ['a', 1] }, { eq: ['b', 2] }] };
    expect(evaluatePredicate(all, { a: 1, b: 2 })).toBe(true);
    expect(evaluatePredicate(all, { a: 1, b: 3 })).toBe(false);

    const any = { any: [{ eq: ['a', 1] }, { eq: ['a', 2] }] };
    expect(evaluatePredicate(any, { a: 2 })).toBe(true);
    expect(evaluatePredicate(any, { a: 3 })).toBe(false);

    expect(evaluatePredicate({ not: { eq: ['a', 1] } }, { a: 2 })).toBe(true);
  });

  test('all: [] is a tautology (true)', () => {
    expect(evaluatePredicate({ all: [] }, { anything: 1 })).toBe(true);
  });
});

describe('predicate exists', () => {
  test('exists over array elements with element-scoped predicate', () => {
    const scope = {
      reactions: [
        { login: 'dependabot[bot]', content: 'eyes' },
        { login: 'codex[bot]', content: '+1' },
      ],
    };
    const codexPlusOne = {
      exists: {
        select: 'reactions',
        where: { all: [{ contains: ['login', 'codex'] }, { eq: ['content', '+1'] }] },
      },
    };
    expect(evaluatePredicate(codexPlusOne, scope)).toBe(true);
  });

  test('exists is false when no element matches', () => {
    const scope = { reactions: [{ login: 'dependabot[bot]', content: '+1' }] };
    const codexPlusOne = {
      exists: { select: 'reactions', where: { contains: ['login', 'codex'] } },
    };
    expect(evaluatePredicate(codexPlusOne, scope)).toBe(false);
  });

  test('exists is false when the select path is missing or not an array', () => {
    const p = { exists: { select: 'reactions', where: { eq: ['x', 1] } } };
    expect(evaluatePredicate(p, {})).toBe(false);
    expect(evaluatePredicate(p, { reactions: 'nope' })).toBe(false);
  });
});
