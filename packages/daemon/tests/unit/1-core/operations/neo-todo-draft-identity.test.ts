import { describe, expect, test } from 'bun:test';
import type { AdapterIdentity, WorkRef } from '../../../../src/lib/drivers/types.ts';
import { resolveNeoTodoDraft } from '../../../../src/lib/neo/todo-operations.ts';

const check = { pack: 'core', kind: 'evidence', params: {} };
const facts: Record<string, AdapterIdentity> = {
  hyperneo: { configurable: true },
  'claude-desktop': { fixedProvider: 'anthropic', configurable: false },
  'laptop:hyperneo': { configurable: true },
};
const draft = (target: object) =>
  resolveNeoTodoDraft(
    { title: 'Step', check, instruction: 'Do it', target } as never,
    async (ref: WorkRef) => ({ value: ref }),
    async (adapter, daemon) => facts[daemon ? `${daemon}:${adapter}` : adapter]
  );

describe('resolveNeoTodoDraft identity admission', () => {
  test.each([
    [{ verb: 'start', adapter: 'hyperneo', model: 'm', effort: 'high' }, 'missing: provider'],
    [{ verb: 'send', ref: { adapter: 'claude-desktop', id: 's' }, model: 'm' }, 'missing: effort'],
    [
      {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'x', daemon: 'laptop', name: 'r' },
        model: 'm',
      },
      'missing: provider, effort',
    ],
    [
      { verb: 'send', ref: { adapter: 'hyperneo', id: 's', daemon: 'laptop' } },
      'missing: provider, model, effort',
    ],
  ])('refuses a local or remote target without the triple: %j', async (target, missing) => {
    expect(await draft(target)).toEqual({
      reason: {
        ok: false,
        reason: `identity_required: name provider, model and effort for new work (${missing})`,
      },
    });
  });

  test.each([
    {
      verb: 'start',
      adapter: 'hyperneo',
      provider: 'p',
      model: 'm',
      effort: 'high',
    },
    {
      verb: 'send',
      ref: { adapter: 'claude-desktop', id: 's' },
      model: 'm',
      effort: 'high',
    },
    {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'x', daemon: 'x', name: 'r' },
    },
    { verb: 'send', ref: { adapter: 'hyperneo', id: 's', daemon: 'x' } },
    { verb: 'bind', ref: { adapter: 'hyperneo', id: 's' } },
  ])('admits a complete, unverifiable remote or bind target: %j', async (target) => {
    expect(await draft(target)).toMatchObject({ value: { target } });
  });
});
