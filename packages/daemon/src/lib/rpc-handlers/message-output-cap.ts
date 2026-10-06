export const MESSAGE_OUTPUT_CAP_CHARS = 16 * 1024;

type Json = Record<string, unknown>;
type Capped<T> = { value: T; cut: number };

function capText(text: string, limit: number): Capped<string> {
  return text.length > limit
    ? { value: text.slice(0, limit), cut: text.length }
    : { value: text, cut: 0 };
}

function capDeep(value: unknown, limit: number): Capped<unknown> {
  if (typeof value === 'string') return capText(value, limit);
  if (Array.isArray(value)) {
    const items = value.map((item) => capDeep(item, limit));
    return { value: items.map((item) => item.value), cut: Math.max(0, ...items.map((i) => i.cut)) };
  }
  if (value && typeof value === 'object') {
    const record = value as Json;
    const source = record.source as Json | undefined;
    if (record.type === 'image' && typeof source?.data === 'string' && source.data.length > limit)
      return {
        value: { type: 'image', image_capped: { chars: source.data.length } },
        cut: source.data.length,
      };
    const entries = Object.entries(value as Json).map(
      ([key, item]) => [key, capDeep(item, limit)] as const
    );
    return {
      value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])),
      cut: Math.max(0, ...entries.map(([, item]) => item.cut)),
    };
  }
  return { value, cut: 0 };
}

function capBlock(block: unknown, limit: number): Capped<unknown> {
  if (!block || typeof block !== 'object') return { value: block, cut: 0 };
  const record = block as Json;
  if (record.type === 'tool_result') {
    const content = capDeep(record.content, limit);
    return content.cut
      ? {
          value: { ...record, content: content.value, output_capped: { chars: content.cut } },
          cut: content.cut,
        }
      : { value: block, cut: 0 };
  }
  if (record.type === 'tool_use') {
    const input = capDeep(record.input, limit);
    return input.cut
      ? {
          value: { ...record, input: input.value, input_capped: { chars: input.cut } },
          cut: input.cut,
        }
      : { value: block, cut: 0 };
  }
  return { value: block, cut: 0 };
}

export function capMessageOutput<T extends Json>(message: T, limit = MESSAGE_OUTPUT_CAP_CHARS): T {
  const inner = message.message as Json | undefined;
  const blocks = Array.isArray(inner?.content)
    ? (inner.content as unknown[]).map((block) => capBlock(block, limit))
    : null;
  const structured = 'tool_use_result' in message ? capDeep(message.tool_use_result, limit) : null;
  const blockCut = blocks?.some((block) => block.cut) ?? false;
  if (!blockCut && !structured?.cut) return message;
  return {
    ...message,
    ...(blockCut ? { message: { ...inner, content: blocks!.map((block) => block.value) } } : {}),
    ...(structured?.cut ? { tool_use_result: structured.value } : {}),
    output_capped: true,
  };
}
