import type { WorkInput } from './types.ts';

const RECENT_INPUTS = 8;
const INPUT_TEXT_LIMIT = 160;

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
