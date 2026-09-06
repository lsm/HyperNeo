import type { SDKMessage } from '@hyperneo/shared/sdk';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeLegacyPromptRole(message: SDKMessage): SDKMessage {
  if (message?.type !== 'user') return message;
  const nested = message.message as Record<string, unknown> | undefined;
  if (nested == null || typeof nested !== 'object' || nested.role !== 'user') return message;
  const { role: _role, ...rest } = nested;
  return { ...message, message: rest } as SDKMessage;
}

export function normalizePromptForComparison(message: SDKMessage): SDKMessage {
  const roleNormalized = normalizeLegacyPromptRole(message);
  const withKind = roleNormalized as SDKMessage & { inputKind?: string };
  if (withKind.inputKind !== 'task') return roleNormalized;
  const normalized = { ...roleNormalized } as SDKMessage & { inputKind?: string };
  delete normalized.inputKind;
  return normalized;
}
