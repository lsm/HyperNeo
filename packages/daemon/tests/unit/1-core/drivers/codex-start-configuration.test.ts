import { describe, expect, test } from 'bun:test';
import { selectCodexConfiguration } from '../../../../src/lib/drivers/codex-start-configuration';

const model = {
  id: 'picker-sol',
  model: 'gpt-6.1-sol',
  displayName: 'GPT-6.1 Sol',
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
};
const page = { data: [model], nextCursor: null };

describe('selectCodexConfiguration', () => {
  test.each(['picker-sol', 'GPT-6.1 Sol', 'sol 6.1', 'gpt-6.1-sol'])(
    'resolves %s from the complete catalog without creating work',
    async (name) => {
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const server = {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          return calls.length === 1 ? { data: [], nextCursor: 'second' } : page;
        },
      };
      expect(await selectCodexConfiguration({ model: name, effort: 'medium' }, server)).toEqual({
        ok: true,
        value: { model: 'gpt-6.1-sol', effort: 'medium' },
      });
      expect(calls).toEqual([
        { method: 'model/list', params: { limit: 100, includeHidden: false } },
        { method: 'model/list', params: { limit: 100, includeHidden: false, cursor: 'second' } },
      ]);
    }
  );
  test('uses the advertised default for effort-only requests and rejects unsupported choices', async () => {
    const server = { call: async () => page };
    expect(await selectCodexConfiguration({ effort: 'medium' }, server)).toEqual({
      ok: true,
      value: { model: 'gpt-6.1-sol', effort: 'medium' },
    });
    expect(await selectCodexConfiguration({ model: 'unknown' }, server)).toMatchObject({
      ok: false,
      reason: 'unsupported_model',
    });
    expect(
      await selectCodexConfiguration({ model: 'sol 6.1', effort: 'ultra' }, server)
    ).toMatchObject({
      ok: false,
      reason: 'unsupported_effort',
    });
  });
  test('no overrides needs no catalog or configuration changes', async () => {
    let calls = 0;
    const result = await selectCodexConfiguration(
      {},
      {
        call: async () => {
          calls++;
          throw new Error('offline');
        },
      }
    );
    expect(result).toEqual({ ok: true, value: {} });
    expect(calls).toBe(0);
  });
  test.each([
    { data: [model] },
    { data: [{ ...model, supportedReasoningEfforts: null }], nextCursor: null },
    { data: [], nextCursor: 2 },
  ])('rejects an unusable catalog instead of selecting a fallback', async (reply) => {
    expect(
      await selectCodexConfiguration({ model: 'sol 6.1' }, { call: async () => reply })
    ).toMatchObject({ ok: false, reason: 'unreachable' });
  });
  test('rejects transport failures and repeated pagination cursors', async () => {
    const unavailable = await selectCodexConfiguration(
      { effort: 'medium' },
      {
        call: async () => {
          throw new Error('offline');
        },
      }
    );
    expect(unavailable).toMatchObject({ ok: false, reason: 'unreachable' });
    let calls = 0;
    const cyclic = await selectCodexConfiguration(
      { model: 'sol 6.1' },
      {
        call: async () => {
          calls++;
          return { ...page, nextCursor: 'same' };
        },
      }
    );
    expect(cyclic).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(calls).toBe(2);
  });
  test('refuses an incomplete catalog at the page limit', async () => {
    let calls = 0;
    const result = await selectCodexConfiguration(
      { model: 'sol 6.1' },
      {
        call: async () => ({ data: [], nextCursor: String(++calls) }),
      }
    );
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(calls).toBe(50);
  });
  test('excludes hidden entries and refuses ambiguous advertised aliases', async () => {
    const request = Object.freeze({ model: 'sol 6.1' });
    expect(
      await selectCodexConfiguration(request, {
        call: async () => ({ data: [{ ...model, hidden: true }], nextCursor: null }),
      })
    ).toMatchObject({ ok: false, reason: 'unsupported_model' });
    expect(
      await selectCodexConfiguration(
        { model: 'GPT-6.1 Sol' },
        {
          call: async () => ({
            data: [model, { ...model, id: 'other', model: 'other' }],
            nextCursor: null,
          }),
        }
      )
    ).toMatchObject({ ok: false, reason: 'unsupported_model' });
    expect(request).toEqual({ model: 'sol 6.1' });
  });
});
