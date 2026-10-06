export const MESSAGE_OUTPUT_CAP_CHARS = 16 * 1024;
const WHOLE_STRING_CHARS = 64;
const SMALL_FIELDS_AFTER_BUDGET = 64;

function isSmallField(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.length <= WHOLE_STRING_CHARS)
  );
}

type Json = Record<string, unknown>;
type Budget = { left: number };
type Capped<T> = { value: T; total: number; dropped: boolean };

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object') return String(value).length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function dropBinary(record: Json, budget: Budget): Capped<unknown> | null {
  const file = record.file as Json | undefined;
  const source = record.source as Json | undefined;
  if (typeof file?.base64 === 'string' && file.base64.length > budget.left)
    return {
      value: {
        ...record,
        file: { ...file, base64: '' },
        data_capped: { chars: file.base64.length },
      },
      total: file.base64.length,
      dropped: true,
    };
  if (
    record.type === 'image' &&
    typeof source?.data === 'string' &&
    source.data.length > budget.left
  )
    return {
      value: { type: 'image', data_capped: { chars: source.data.length } },
      total: source.data.length,
      dropped: true,
    };
  return null;
}

function capDeep(value: unknown, budget: Budget): Capped<unknown> {
  if (typeof value === 'string') {
    if (value.length <= WHOLE_STRING_CHARS) {
      budget.left -= value.length;
      return { value, total: value.length, dropped: false };
    }
    const kept = Math.max(0, Math.min(value.length, budget.left));
    budget.left -= kept;
    return { value: value.slice(0, kept), total: value.length, dropped: kept < value.length };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    let total = 0;
    let dropped = false;
    for (let index = 0; index < value.length; index++) {
      if (budget.left <= 0) {
        total += sizeOf(value.slice(index));
        dropped = true;
        break;
      }
      const item = capDeep(value[index], budget);
      items.push(item.value);
      total += item.total;
      dropped ||= item.dropped;
    }
    return { value: items, total, dropped };
  }
  if (value && typeof value === 'object') {
    const image = dropBinary(value as Json, budget);
    if (image) return image;
    const result: Json = {};
    let total = 0;
    let dropped = false;
    let keptAfterBudget = 0;
    for (const [key, item] of Object.entries(value as Json)) {
      if (budget.left <= 0) {
        if (isSmallField(item) && keptAfterBudget < SMALL_FIELDS_AFTER_BUDGET) {
          result[key] = item;
          keptAfterBudget++;
        } else {
          total += sizeOf(item);
          dropped = true;
        }
        continue;
      }
      const capped = capDeep(item, budget);
      result[key] = capped.value;
      total += capped.total;
      dropped ||= capped.dropped;
    }
    return { value: result, total, dropped };
  }
  return { value, total: 0, dropped: false };
}

function capWithin(value: unknown, limit: number): Capped<unknown> {
  return capDeep(value, { left: limit });
}

function capBlock(block: unknown, limit: number): Capped<unknown> {
  if (!block || typeof block !== 'object' || (block as Json).type !== 'tool_result')
    return { value: block, total: 0, dropped: false };
  const record = block as Json;
  const content = capWithin(record.content, limit);
  return content.dropped
    ? {
        value: { ...record, content: content.value, output_capped: { chars: content.total } },
        total: content.total,
        dropped: true,
      }
    : { value: block, total: content.total, dropped: false };
}

function markStructured(capped: Capped<unknown>): unknown {
  return capped.value && typeof capped.value === 'object' && !Array.isArray(capped.value)
    ? { ...(capped.value as Json), output_capped: { chars: capped.total } }
    : capped.value;
}

export function capMessageOutput<T extends Json>(message: T, limit = MESSAGE_OUTPUT_CAP_CHARS): T {
  const inner = message.message as Json | undefined;
  const blocks = Array.isArray(inner?.content)
    ? (inner.content as unknown[]).map((block) => capBlock(block, limit))
    : null;
  const structured =
    'tool_use_result' in message ? capWithin(message.tool_use_result, limit) : null;
  const blockDropped = blocks?.some((block) => block.dropped) ?? false;
  if (!blockDropped && !structured?.dropped) return message;
  return {
    ...message,
    ...(blockDropped
      ? { message: { ...inner, content: blocks!.map((block) => block.value) } }
      : {}),
    ...(structured?.dropped ? { tool_use_result: markStructured(structured) } : {}),
    output_capped: true,
  };
}

export function capSdkMessage<T>(message: T): T {
  return capMessageOutput(message as unknown as Json) as unknown as T;
}
