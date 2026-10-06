import { TOOL_SUMMARY_INPUT_FIELDS, WHOLE_INPUT_TOOLS } from '@hyperneo/shared';

type Json = Record<string, unknown>;

const SUMMARY_FIELD_CHARS = 500;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function summaryInput(input: unknown): Json {
  if (!isRecord(input)) return {};
  const kept: Json = {};
  for (const field of TOOL_SUMMARY_INPUT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    kept[field] = typeof value === 'string' ? value.slice(0, SUMMARY_FIELD_CHARS) : value;
  }
  return kept;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is Json => isRecord(part) && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

function firstLine(text: string): string {
  return text.trimStart().split('\n', 1)[0].slice(0, SUMMARY_FIELD_CHARS);
}

function thinBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  if (block.type === 'tool_use') {
    return WHOLE_INPUT_TOOLS.includes(String(block.name))
      ? block
      : { ...block, input: summaryInput(block.input), input_thinned: true };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      is_error: block.is_error,
      content: block.is_error ? firstLine(resultText(block.content)) : '',
      output_thinned: true,
    };
  }
  if (block.type === 'thinking') {
    const text = typeof block.thinking === 'string' ? block.thinking : '';
    return { type: 'thinking', thinking: '', thinking_chars: text.length };
  }
  return block;
}

export function thinMessage(message: Json): Json {
  const inner = isRecord(message.message) ? message.message : null;
  const content = Array.isArray(inner?.content) ? inner.content.map(thinBlock) : null;
  const { tool_use_result: _dropped, ...rest } = message;
  return {
    ...rest,
    ...(content ? { message: { ...inner, content } } : {}),
    thinned: true,
  };
}
