import { describe, expect, test } from 'bun:test';
import { diffApiSurfaces, formatApiDiff, type ApiSurface } from './api-diff.ts';
import { extractPhoneMethods } from './api-phone-methods.ts';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const string = { type: 'string' };
function surface(
  inputSchema: unknown = object({}),
  resultSchema: unknown = object({})
): ApiSurface {
  return { operations: [{ name: 'neo.sample', inputSchema, resultSchema }], events: [] };
}
const diff = (before: ApiSurface, after: ApiSurface, phone = ['neo.sample']) =>
  diffApiSurfaces(before, after, phone);

describe('API compatibility report', () => {
  test('marks a new operation safe and removed operation breaking, with exact phone coverage', () => {
    expect(diff({ operations: [], events: [] }, surface())[0]).toMatchObject({
      operation: 'neo.sample',
      level: 'safe',
      phoneUsed: true,
    });
    expect(diff(surface(), { operations: [], events: [] }, [])[0]).toMatchObject({
      operation: 'neo.sample',
      level: 'breaking',
      phoneUsed: false,
    });
  });
  test('new optional input and new result fields are safe; new required input is breaking', () => {
    const input = diff(surface(), surface(object({ title: string })));
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ level: 'safe', path: 'input.title' });
    expect(diff(surface(), surface(object({ title: string }, ['title'])))[0]?.level).toBe(
      'breaking'
    );
    expect(
      diff(surface(), surface(object({}), object({ title: string }, ['title'])))[0]?.level
    ).toBe('safe');
  });
  test('an existing input field becoming required is breaking', () => {
    expect(diff(surface(object({ a: string })), surface(object({ a: string }, ['a'])))).toEqual([
      expect.objectContaining({ level: 'breaking', path: 'input.a' }),
    ]);
  });
  test('result fields becoming optional or nullable are risky', () => {
    const before = surface(object({}), object({ note: string }, ['note']));
    expect(diff(before, surface(object({}), object({ note: string })))[0]?.level).toBe('risky');
    expect(
      diff(before, surface(object({}), object({ note: { type: ['string', 'null'] } }, ['note'])))
    ).toEqual([expect.objectContaining({ level: 'risky', path: 'result.note' })]);
    const enumField = { type: 'string', enum: ['a'] };
    expect(
      diff(
        surface(object({}), enumField),
        surface(object({}), { anyOf: [enumField, { type: 'null' }] })
      )
    ).toEqual([expect.objectContaining({ level: 'risky', path: 'result' })]);
  });
  test('field removal/rename and type changes are breaking at the field path', () => {
    const before = surface(object({ a: string }));
    expect(diff(before, surface(object({ b: string })))).toContainEqual(
      expect.objectContaining({ level: 'breaking', path: 'input.a' })
    );
    expect(diff(before, surface(object({ a: { type: 'number' } })))[0]).toMatchObject({
      level: 'breaking',
      path: 'input.a',
    });
  });
  test('result enum additions are risky and input enum removals are breaking', () => {
    const values = (names: string[]) => ({ type: 'string', enum: names });
    expect(
      diff(surface(object({}), values(['text'])), surface(object({}), values(['text', 'link'])))[0]
    ).toMatchObject({ level: 'risky', path: 'result' });
    expect(diff(surface(values(['a', 'b'])), surface(values(['a'])))[0]?.level).toBe('breaking');
  });
  test('one-sided enum constraints respect input and result variance', () => {
    const bounded = { type: 'string', enum: ['ready'] };
    expect(diff(surface(object({}), string), surface(object({}), bounded))).toEqual([
      expect.objectContaining({ level: 'safe', path: 'result' }),
    ]);
    expect(diff(surface(object({}), bounded), surface(object({}), string))).toEqual([
      expect.objectContaining({ level: 'risky', path: 'result' }),
    ]);
    expect(diff(surface(string), surface(bounded))).toEqual([
      expect.objectContaining({ level: 'breaking', path: 'input' }),
    ]);
    expect(diff(surface(bounded), surface(string))).toEqual([
      expect.objectContaining({ level: 'safe', path: 'input' }),
    ]);
  });
  test('union variant additions are risky in results and ignore order', () => {
    const variant = (kind: string, title: unknown = string) =>
      object({ kind: { const: kind }, title });
    const a = variant('a');
    const b = variant('b');
    const c = variant('c');
    expect(
      diff(surface(object({}), { anyOf: [a, b] }), surface(object({}), { anyOf: [b, a] }))
    ).toEqual([]);
    expect(
      diff(surface(object({}), { anyOf: [a, b] }), surface(object({}), { anyOf: [a, b, c] }))
    ).toEqual([expect.objectContaining({ level: 'risky', path: 'result' })]);
    expect(
      diff(
        surface(object({}), { oneOf: [a, b] }),
        surface(object({}), { oneOf: [variant('a', { type: 'number' }), b] })
      )
    ).toContainEqual(expect.objectContaining({ level: 'breaking', path: 'result[a].title' }));
    expect(diff(surface(object({}), a), surface(object({}), { anyOf: [a, b] }))).toEqual([
      expect.objectContaining({ level: 'risky', path: 'result' }),
    ]);
    expect(
      diff(surface(object({}), string), surface(object({}), { type: ['string', 'number'] }))
    ).toEqual([expect.objectContaining({ level: 'risky', path: 'result' })]);
  });
  test('local schema references preserve detailed classifications, including recursive definitions', () => {
    const schema = (names: string[]) => ({
      $defs: { value: { type: 'string', enum: names }, recursive: { $ref: '#/$defs/recursive' } },
      ...object({ value: { $ref: '#/$defs/value' }, next: { $ref: '#/$defs/recursive' } }),
    });
    expect(
      diff(surface(object({}), schema(['a'])), surface(object({}), schema(['a', 'b'])))
    ).toEqual([expect.objectContaining({ level: 'risky', path: 'result.value' })]);
    const union = (names: string[]) => ({
      $defs: { value: { type: 'string', enum: names } },
      anyOf: [object({ value: { $ref: '#/$defs/value' } }), { type: 'null' }],
    });
    expect(diff(surface(object({}), union(['a'])), surface(object({}), union(['a', 'b'])))).toEqual(
      [expect.objectContaining({ level: 'risky', path: 'result.value' })]
    );
  });
  test('nullable references preserve their value constraints', () => {
    const reference = { $defs: { value: { type: 'string', enum: ['a'] } }, $ref: '#/$defs/value' };
    expect(
      diff(
        surface(object({}), reference),
        surface(object({}), {
          $defs: reference.$defs,
          anyOf: [{ $ref: '#/$defs/value' }, { type: 'null' }],
        })
      )
    ).toEqual([expect.objectContaining({ level: 'risky', path: 'result' })]);
  });
  test('a new result field inside an intersection remains safe', () => {
    expect(
      diff(
        surface(object({}), { allOf: [object({ a: string })] }),
        surface(object({}), { allOf: [object({ a: string, b: string })] })
      )
    ).toEqual([expect.objectContaining({ level: 'safe', path: 'result.b' })]);
  });
  test('constraint and opaque-transform changes cannot silently appear unchanged', () => {
    expect(
      diff(surface({ type: 'string', minLength: 1 }), surface({ type: 'string', minLength: 2 }))[0]
        ?.level
    ).toBe('breaking');
    expect(
      diff(
        surface(object({}), { 'x-zod-transform-sha256': 'old' }),
        surface(object({}), { 'x-zod-transform-sha256': 'new' })
      )[0]?.level
    ).toBe('risky');
  });
  test('metadata, required ordering and enum ordering do not create false changes', () => {
    const a = { ...object({ a: string, b: string }, ['b', 'a']), description: 'old' };
    const b = { ...object({ b: string, a: string }, ['a', 'b']), description: 'new' };
    expect(diff(surface(a, { enum: ['b', 'a'] }), surface(b, { enum: ['a', 'b'] }))).toEqual([]);
  });
  test('event method removals cannot disappear from the report', () => {
    expect(diff({ ...surface(), events: ['neo.changed'] }, surface(), ['neo.changed'])).toEqual([
      expect.objectContaining({
        operation: 'neo.changed',
        path: 'event',
        level: 'breaking',
        phoneUsed: true,
      }),
    ]);
  });
  test('rejects duplicate operations instead of concealing a removal', () => {
    expect(() =>
      diff(
        { ...surface(), operations: [...surface().operations, ...surface().operations] },
        surface()
      )
    ).toThrow('Duplicate');
  });
  test('release-note summary separates phone-used counts from all API changes', () => {
    const changes = diff(surface(), surface(object({ title: string }, ['title'])), []);
    const report = formatApiDiff('v1.0.0', 'v1.1.0', changes);
    expect(report).toContain(
      'v1.0.0 -> v1.1.0: phone-used operations: 0 breaking, 0 risky, 0 safe'
    );
    expect(report).toContain('All changes: 1 breaking, 0 risky, 0 safe');
    expect(report).toContain('input.title');
  });
});

test('phone inventory extracts literal calls/events, not UI labels, and is stable', () => {
  expect(
    extractPhoneMethods(`
    try await hub.invoke("neo.snapshot")
    hub.request(\n "message.send", payload)
    hub.onEvent("neo.changed") { _ in }
    other.call("work.status")
    hub.invoke("artifact.file.get")
    referenceRequest("artifact.reference.resolve", payload)
    hub.invoke("neo.snapshot")
    Text("neo.log.1")
  `)
  ).toEqual([
    'artifact.file.get',
    'artifact.reference.resolve',
    'message.send',
    'neo.changed',
    'neo.snapshot',
    'work.status',
  ]);
});
