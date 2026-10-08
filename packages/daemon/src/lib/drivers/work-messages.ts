import type { WorkExchangeEntry, WorkInput } from './types.ts';

const RECENT_INPUTS = 8;
const INPUT_TEXT_LIMIT = 160;
const EXCHANGE_TEXT_LIMIT = 4_000;
const EXCHANGE_ENTRIES = 40;

export function workEntryTime(timestamp: unknown): number | undefined {
  const at = Date.parse(String(timestamp));
  return Number.isFinite(at) ? at : undefined;
}

export function workInput(at: number | undefined, text: string): WorkInput | null {
  const plain = text.replace(/\s+/g, ' ').trim();
  return at !== undefined && plain ? { at, text: plain.slice(0, INPUT_TEXT_LIMIT) } : null;
}

export function recentWorkInputs(inputs: readonly WorkInput[]): WorkInput[] {
  return inputs.slice(-RECENT_INPUTS);
}

export interface WorkExchange {
  entries: WorkExchangeEntry[];
  cut: boolean;
}

export function exchangeEntry(
  at: number | undefined,
  role: WorkExchangeEntry['role'],
  text: string,
  since: number
): WorkExchangeEntry | null {
  const trimmed = text.trim();
  return at !== undefined && at > since && trimmed
    ? { at, role, text: trimmed.slice(0, EXCHANGE_TEXT_LIMIT) }
    : null;
}

export function boundExchange(entries: WorkExchangeEntry[], cut: boolean): WorkExchange {
  return entries.length <= EXCHANGE_ENTRIES
    ? { entries, cut }
    : { entries: entries.slice(-EXCHANGE_ENTRIES), cut: true };
}

export function withExchange(exchange: WorkExchange | undefined) {
  return exchange
    ? { exchange: exchange.entries, ...(exchange.cut ? { exchangeCut: true } : {}) }
    : {};
}
