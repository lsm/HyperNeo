import { z } from 'zod';

type Schema = z.core.JSONSchema.BaseSchema;

function* combinations(
  fields: [string, Schema][],
  root: Schema
): Generator<Record<string, unknown>> {
  const [first, ...rest] = fields;
  if (!first) {
    yield {};
    return;
  }
  for (const value of candidates(first[1], root))
    for (const tail of combinations(rest, root)) yield { [first[0]]: value, ...tail };
}

function* candidates(node: Schema, root: Schema): Generator<unknown> {
  if (node.examples) yield* node.examples;
  if ('default' in node) yield node.default;
  if ('const' in node) {
    yield node.const;
    return;
  }
  if (node.enum) {
    yield* node.enum;
    return;
  }
  if (node.$ref) {
    const name = node.$ref.replace('#/$defs/', '');
    if (root.$defs?.[name]) yield* candidates(root.$defs[name], root);
    return;
  }
  const variants = node.anyOf ?? node.oneOf;
  if (variants) {
    for (const variant of variants) yield* candidates(variant, root);
    return;
  }
  if (node.type === 'object') {
    const fields = Object.entries(node.properties ?? {}) as [string, Schema][];
    const required = fields.filter(([name]) => node.required?.includes(name));
    const optional = fields.filter(([name]) => !node.required?.includes(name));
    yield* combinations(required, root);
    for (const field of optional) yield* combinations([...required, field], root);
    if (optional.length > 1) yield* combinations(fields, root);
    return;
  }
  if (node.type === 'array') {
    const count = Math.max(node.minItems ?? 0, node.prefixItems?.length ?? 0);
    const fields: [string, Schema][] = Array.from({ length: count }, (_, index) => [
      String(index),
      (node.prefixItems?.[index] ?? (typeof node.items === 'object' ? node.items : {})) as Schema,
    ]);
    for (const row of combinations(fields, root)) yield Object.values(row);
    return;
  }
  if (node.type === 'string') {
    const formats: Record<string, string> = {
      uuid: '00000000-0000-4000-8000-000000000001',
      uri: 'https://example.com',
      email: 'user@example.com',
      'date-time': '2026-01-01T00:00:00.000Z',
      date: '2026-01-01',
      time: '12:00:00Z',
    };
    const values = [formats[node.format ?? ''] ?? 'example', 'example/repo', 'a'.repeat(64)];
    for (const value of values) {
      const text = value.padEnd(node.minLength ?? 0, 'x').slice(0, node.maxLength);
      if (!node.pattern || new RegExp(node.pattern).test(text)) {
        yield text;
        return;
      }
    }
    return;
  }
  if (node.type === 'number' || node.type === 'integer') {
    const step = node.multipleOf ?? (node.type === 'integer' ? 1 : 0.5);
    const exclusive = typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum : undefined;
    const lower = node.minimum ?? exclusive ?? Math.min(0, node.maximum ?? 0);
    let number = Math.ceil(lower / step) * step;
    if (exclusive !== undefined && number <= exclusive) number += step;
    yield number;
    return;
  }
  if (node.type === 'boolean') {
    yield false;
    yield true;
    return;
  }
  yield null;
}

const examples = new WeakMap<z.ZodType, Promise<string>>();

export function operationInputExample(schema: z.ZodType): Promise<string> {
  const cached = examples.get(schema);
  if (cached) return cached;
  const pending = (async () => {
    const declared = schema.meta()?.examples;
    for (const input of Array.isArray(declared) ? declared : [])
      if ((await schema.safeParseAsync(input).catch(() => null))?.success)
        return `\nExample input: ${JSON.stringify(input)}`;
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Schema;
    for (const input of candidates(json, json))
      if ((await schema.safeParseAsync(input).catch(() => null))?.success)
        return `\nExample input: ${JSON.stringify(input)}`;
    return '';
  })().catch(() => '');
  examples.set(schema, pending);
  return pending;
}
