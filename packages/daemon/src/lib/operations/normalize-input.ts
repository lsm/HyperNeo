import { z } from 'zod';

const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const commonAliases: Readonly<Record<string, readonly string[]>> = {
  todoId: ['todo_id'],
  message: ['text'],
};

export async function normalizeOperationInput(schema: z.ZodType, input: unknown): Promise<unknown> {
  if (input === undefined || input === null) return input;
  if (schema instanceof z.ZodString && typeof input === 'number' && Number.isFinite(input))
    return String(input);
  if (schema instanceof z.ZodNumber && typeof input === 'string') {
    const text = input.trim();
    return decimal.test(text) && Number.isFinite(Number(text)) ? Number(text) : input;
  }
  if (schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum) {
    const values: readonly unknown[] =
      schema instanceof z.ZodLiteral ? [...schema.values] : schema.options;
    if (values.includes(input)) return input;
    if (typeof input === 'number' && Number.isFinite(input)) {
      const text = String(input);
      return values.includes(text) ? text : input;
    }
    if (typeof input === 'string') {
      const text = input.trim();
      const number = Number(text);
      return decimal.test(text) && Number.isFinite(number) && values.includes(number)
        ? number
        : input;
    }
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  )
    return normalizeOperationInput(schema.unwrap() as z.ZodType, input);
  if (schema instanceof z.ZodPipe) return normalizeOperationInput(schema.in as z.ZodType, input);
  if (schema instanceof z.ZodLazy)
    return normalizeOperationInput(schema.unwrap() as z.ZodType, input);
  if (schema instanceof z.ZodUnion) {
    if ((await schema.safeParseAsync(input)).success) return input;
    const candidates: unknown[] = [];
    for (const option of schema.options) {
      const branch = option as z.ZodType;
      const normalized = await normalizeOperationInput(branch, input);
      if ((await branch.safeParseAsync(normalized)).success) candidates.push(normalized);
    }
    return candidates.length === 1 ? candidates[0] : input;
  }
  if (schema instanceof z.ZodArray && Array.isArray(input))
    return Promise.all(
      input.map((item) => normalizeOperationInput(schema.element as z.ZodType, item))
    );
  if (schema instanceof z.ZodTuple && Array.isArray(input))
    return Promise.all(
      input.map((item, index) => {
        const child = schema.def.items[index] ?? schema.def.rest;
        return child ? normalizeOperationInput(child as z.ZodType, item) : item;
      })
    );
  if (typeof input !== 'object' || Array.isArray(input)) return input;
  const entries = Object.entries(input);
  if (schema instanceof z.ZodRecord)
    return Object.fromEntries(
      await Promise.all(
        entries.map(async ([key, value]) => [
          key,
          await normalizeOperationInput(schema.valueType as z.ZodType, value),
        ])
      )
    );
  if (!(schema instanceof z.ZodObject)) return input;
  const fields = new Map(entries);
  for (const [name, field] of Object.entries(schema.shape)) {
    const child = field as z.ZodType;
    const declaredAliases = child.meta()?.aliases;
    const aliases = [
      ...(commonAliases[name] ?? []),
      ...(Array.isArray(declaredAliases) ? declaredAliases : []),
    ];
    for (const alias of aliases) {
      if (typeof alias !== 'string' || Object.hasOwn(schema.shape, alias) || !fields.has(alias))
        continue;
      if (fields.has(name)) throw new Error(`Conflicting fields: ${name} and ${alias}`);
      fields.set(name, fields.get(alias));
      fields.delete(alias);
    }
    if (fields.has(name)) fields.set(name, await normalizeOperationInput(child, fields.get(name)));
  }
  return Object.fromEntries(fields);
}
