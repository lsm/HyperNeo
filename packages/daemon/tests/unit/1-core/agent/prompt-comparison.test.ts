import { describe, expect, it } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  canonicalJson,
  normalizeLegacyPromptRole,
  normalizePromptForComparison,
} from '../../../../src/lib/agent/prompt-comparison';

function userMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'user',
    uuid: 'uuid-1',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ...overrides,
  } as SDKMessage;
}

describe('prompt-comparison', () => {
  describe('canonicalJson', () => {
    it('orders object keys so differently-ordered objects canonicalize equal', () => {
      const a = { z: 1, a: { y: 2, b: 3 } };
      const b = { a: { b: 3, y: 2 }, z: 1 };
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    });

    it('drops undefined-valued entries', () => {
      expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    });

    it('renders arrays element-wise and falls back to JSON.stringify for primitives', () => {
      expect(canonicalJson([2, { b: 1, a: 1 }, 'x'])).toBe('[2,{"a":1,"b":1},"x"]');
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(42)).toBe('42');
    });

    it('distinguishes genuinely different content', () => {
      expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    });
  });

  describe('normalizeLegacyPromptRole', () => {
    it('strips the nested role from a user message', () => {
      const normalized = normalizeLegacyPromptRole(userMessage());
      expect((normalized.message as Record<string, unknown>).role).toBeUndefined();
      expect((normalized.message as Record<string, unknown>).content).toEqual([
        { type: 'text', text: 'hello' },
      ]);
    });

    it('returns non-user messages unchanged', () => {
      const message = { type: 'assistant', uuid: 'uuid-1' } as SDKMessage;
      expect(normalizeLegacyPromptRole(message)).toBe(message);
    });

    it('leaves nested payloads without a user role untouched', () => {
      const message = userMessage({ message: { content: [{ type: 'text', text: 'hi' }] } });
      expect(normalizeLegacyPromptRole(message)).toBe(message);
    });
  });

  describe('normalizePromptForComparison', () => {
    it('drops inputKind task and strips the nested role', () => {
      const normalized = normalizePromptForComparison(
        userMessage({ inputKind: 'task' })
      ) as SDKMessage & { inputKind?: string };
      expect(normalized.inputKind).toBeUndefined();
      expect((normalized.message as Record<string, unknown>).role).toBeUndefined();
    });

    it('keeps inputKind values other than task', () => {
      const normalized = normalizePromptForComparison(
        userMessage({ inputKind: 'resume' })
      ) as SDKMessage & { inputKind?: string };
      expect(normalized.inputKind).toBe('resume');
    });

    it('applies role normalization to messages without inputKind', () => {
      const normalized = normalizePromptForComparison(userMessage());
      expect((normalized.message as Record<string, unknown>).role).toBeUndefined();
    });
  });
});
