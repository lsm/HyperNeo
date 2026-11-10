export type ChangeLevel = 'safe' | 'risky' | 'breaking';
export type ApiChange = {
  operation: string;
  path: string;
  level: ChangeLevel;
  message: string;
  phoneUsed: boolean;
  coverageOnly?: boolean;
};
type Schema = Record<string, unknown>;
const record = (value: unknown): Schema =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : {};
const ignored = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'description',
  'title',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
export function signature(value: unknown, key = ''): string {
  const normalize = (v: unknown, k: string): unknown => {
    if (Array.isArray(v)) {
      const array = v.map((child) => normalize(child, ''));
      return ['enum', 'required', 'anyOf', 'oneOf', 'allOf'].includes(k)
        ? array.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : array;
    }
    return v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, child]) => [name, normalize(child, name)])
        )
      : v;
  };
  return JSON.stringify(normalize(value, key)) ?? 'undefined';
}
function dereference(value: unknown, root: unknown): unknown {
  const visited = new Set<string>();
  while (typeof record(value).$ref === 'string') {
    const node = record(value);
    const ref = node.$ref as string;
    if (visited.has(ref)) break;
    visited.add(ref);
    if (!ref.startsWith('#/')) throw new Error(`Unsupported external schema reference: ${ref}`);
    let target = root;
    for (const part of ref.slice(2).split('/'))
      target =
        target && typeof target === 'object'
          ? (target as Schema)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
          : undefined;
    if (target === undefined) throw new Error(`Unresolved schema reference: ${ref}`);
    const { $ref: _ref, ...siblings } = node;
    value = Object.keys(siblings).length ? { ...record(target), ...siblings } : target;
  }
  return value;
}
function variantIdentity(value: unknown): { key: string; label: string } | undefined {
  const schema = record(value);
  const constants = Object.entries(record(schema.properties))
    .filter(([, child]) => 'const' in record(child))
    .map(([name, child]) => [name, record(child).const]);
  if (constants.length)
    return { key: signature(constants.sort()), label: String(constants[0]?.[1]) };
  if ('const' in schema) return { key: signature(schema.const), label: String(schema.const) };
  return undefined;
}
function withoutNull(schema: unknown): { nullable: boolean; value: unknown } {
  const node = record(schema);
  if (Array.isArray(node.type) && node.type.includes('null') && node.type.length > 1) {
    const types = node.type.filter((type) => type !== 'null');
    return { nullable: true, value: { ...node, type: types.length === 1 ? types[0] : types } };
  }
  for (const key of ['anyOf', 'oneOf']) {
    const variants = node[key] as unknown[] | undefined;
    if (!Array.isArray(variants)) continue;
    const remaining = variants.filter((v) => record(v).type !== 'null' && record(v).const !== null);
    if (remaining.length && remaining.length !== variants.length) {
      const { [key]: _union, ...rest } = node;
      return {
        nullable: true,
        value:
          remaining.length === 1
            ? { ...record(remaining[0]), ...rest }
            : { ...rest, [key]: remaining },
      };
    }
  }
  return { nullable: false, value: schema };
}
export function diffSchemas(
  before: unknown,
  after: unknown,
  side: 'input' | 'result',
  emit: (path: string, level: ChangeLevel, message: string) => void
): void {
  if (signature(before) === signature(after)) return;
  const walk = (
    left: unknown,
    right: unknown,
    path: string,
    ancestors: [unknown, unknown][] = []
  ) => {
    left = dereference(left, before);
    right = dereference(right, after);
    if (ancestors.some(([a, b]) => a === left && b === right)) return;
    const stack: [unknown, unknown][] = [...ancestors, [left, right]];
    const an = withoutNull(left),
      bn = withoutNull(right);
    if (an.nullable !== bn.nullable)
      emit(
        path,
        bn.nullable
          ? side === 'result'
            ? 'risky'
            : 'safe'
          : side === 'input'
            ? 'breaking'
            : 'safe',
        bn.nullable ? 'Field becomes nullable' : 'Field becomes non-nullable'
      );
    left = dereference(an.value, before);
    right = dereference(bn.value, after);
    const a = record(left),
      b = record(right);
    const send = (level: ChangeLevel, message: string) => emit(path, level, message);
    if (typeof left === 'boolean' || typeof right === 'boolean') {
      send('breaking', 'Schema acceptance changed');
      return;
    }
    const unionA = ['anyOf', 'oneOf'].find((key) => Array.isArray(a[key]));
    const unionB = ['anyOf', 'oneOf'].find((key) => Array.isArray(b[key]));
    if (!!unionA !== !!unionB) {
      const key = (unionA ?? unionB)!;
      walk(unionA ? left : { [key]: [left] }, unionB ? right : { [key]: [right] }, path, stack);
      return;
    }
    const types = (schema: Schema) =>
      schema.type === undefined
        ? []
        : Array.isArray(schema.type)
          ? (schema.type as string[])
          : [schema.type as string];
    const at = types(a),
      bt = types(b);
    if (signature(at, 'enum') !== signature(bt, 'enum')) {
      const grows = at.length > 0 && at.every((t) => bt.includes(t));
      const narrows = bt.length > 0 && bt.every((t) => at.includes(t));
      send(
        grows
          ? side === 'result'
            ? 'risky'
            : 'safe'
          : narrows
            ? side === 'input'
              ? 'breaking'
              : 'safe'
            : 'breaking',
        `Type changed: ${at.join('|') || 'any'} -> ${bt.join('|') || 'any'}`
      );
    }
    const ap = record(a.properties),
      bp = record(b.properties);
    const ar = new Set((a.required as string[]) ?? []),
      br = new Set((b.required as string[]) ?? []);
    for (const name of [
      ...new Set([...Object.keys(ap), ...Object.keys(bp), ...ar, ...br]),
    ].sort()) {
      const field = `${path}.${name}`;
      if (name in ap && !(name in bp)) emit(field, 'breaking', 'Field removed');
      else if (!(name in ap) && name in bp)
        emit(
          field,
          side === 'input' && br.has(name) ? 'breaking' : 'safe',
          `${side === 'input' && br.has(name) ? 'Required' : 'New'} ${side} field added`
        );
      else {
        if (!ar.has(name) && br.has(name))
          emit(field, side === 'input' ? 'breaking' : 'safe', 'Field becomes required');
        if (ar.has(name) && !br.has(name))
          emit(field, side === 'result' ? 'risky' : 'safe', 'Field becomes optional');
        if (name in ap && name in bp) walk(ap[name], bp[name], field, stack);
      }
    }
    const choices = (schema: Schema) =>
      'const' in schema ? [schema.const] : (schema.enum as unknown[] | undefined);
    const av = choices(a),
      bv = choices(b);
    if (av && bv) {
      const old = new Set(av.map((v) => signature(v))),
        next = new Set(bv.map((v) => signature(v)));
      const removed = [...old].filter((v) => !next.has(v)),
        added = [...next].filter((v) => !old.has(v));
      if (removed.length)
        send(
          side === 'input' ? 'breaking' : 'safe',
          `Enum/constant value removed: ${removed.join(', ')}`
        );
      if (added.length)
        send(
          side === 'result' ? 'risky' : 'safe',
          `Enum/constant value added: ${added.join(', ')}`
        );
    } else if (av) send(side === 'input' ? 'safe' : 'risky', 'Enum/constant constraint removed');
    else if (bv) send(side === 'input' ? 'breaking' : 'safe', 'Enum/constant constraint added');
    for (const union of ['anyOf', 'oneOf']) {
      const old = a[union] as unknown[] | undefined,
        next = b[union] as unknown[] | undefined;
      if (!old && !next) continue;
      if (!old || !next) {
        send('breaking', `${union} structure changed`);
        continue;
      }
      let unmatched = [...next];
      const previous: unknown[] = [];
      for (const value of old) {
        const index = unmatched.findIndex((candidate) => signature(value) === signature(candidate));
        if (index < 0) previous.push(value);
        else {
          const identity = variantIdentity(dereference(value, before));
          walk(value, unmatched[index], identity ? `${path}[${identity.label}]` : path, stack);
          unmatched.splice(index, 1);
        }
      }
      for (const value of [...previous]) {
        const identity = variantIdentity(dereference(value, before));
        const candidates = identity
          ? unmatched.filter(
              (candidate) => variantIdentity(dereference(candidate, after))?.key === identity.key
            )
          : [];
        if (candidates.length !== 1) continue;
        walk(value, candidates[0], `${path}[${identity!.label}]`, stack);
        previous.splice(previous.indexOf(value), 1);
        unmatched.splice(unmatched.indexOf(candidates[0]), 1);
      }
      if (previous.length === 1 && unmatched.length === 1)
        walk(previous[0], unmatched[0], path, stack);
      else if (previous.length && unmatched.length)
        send('breaking', 'Unmatched union alternatives changed; review required');
      else {
        if (previous.length)
          send(side === 'input' ? 'breaking' : 'safe', 'Union alternative removed');
        if (unmatched.length) send(side === 'result' ? 'risky' : 'safe', 'Union alternative added');
      }
    }
    for (const key of ['items', 'additionalProperties']) {
      if (a[key] && b[key] && typeof a[key] === 'object' && typeof b[key] === 'object')
        walk(a[key], b[key], `${path}${key === 'items' ? '[]' : '.*'}`, stack);
      else if (signature(a[key]) !== signature(b[key]))
        send('breaking', `${key} constraint changed`);
    }
    if (a.allOf || b.allOf) {
      const old = a.allOf as unknown[] | undefined,
        next = b.allOf as unknown[] | undefined;
      if (old && next && old.length === next.length) {
        const remaining = [...next];
        const previous: unknown[] = [];
        for (const value of old) {
          const index = remaining.findIndex(
            (candidate) => signature(candidate) === signature(value)
          );
          if (index < 0) previous.push(value);
          else {
            walk(value, remaining[index], path, stack);
            remaining.splice(index, 1);
          }
        }
        if (previous.length <= 1)
          previous.forEach((value, index) => walk(value, remaining[index], path, stack));
        else if (previous.length)
          send('breaking', 'Intersection constraints changed; review required');
      } else send('breaking', 'Intersection constraints changed; review required');
    }
    const handled = new Set([
      ...ignored,
      '$ref',
      'type',
      'properties',
      'required',
      'enum',
      'const',
      'anyOf',
      'oneOf',
      'allOf',
      'items',
      'additionalProperties',
    ]);
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      if (!handled.has(key) && signature(a[key], key) !== signature(b[key], key))
        send(
          key === 'default' || key.startsWith('x-zod-') ? 'risky' : 'breaking',
          `${key} changed${key.startsWith('x-zod-') ? '; opaque schema requires review' : ''}`
        );
  };
  walk(before, after, side);
}
