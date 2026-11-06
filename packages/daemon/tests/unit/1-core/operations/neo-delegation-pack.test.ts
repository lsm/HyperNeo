import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createDelegationPack } from '../../../../src/lib/neo/packs/delegation/pack.ts';
import { neoPacks, neoPackBriefs } from '../../../../src/lib/neo/pack-selection.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import {
  createPackPreferenceOperations,
  validatePackPreference,
} from '../../../../src/lib/neo/preference-operations.ts';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
});
afterEach(() => db.close());

const defaults = {
  signIn: 'self',
  verificationCodes: 'self',
  formFill: 'ask',
  payment: 'self',
  commitments: 'ask',
  humanStep: 'computer',
};
const facts = (pack: ReturnType<typeof createDelegationPack>) =>
  JSON.parse(pack.instructions()!.split('Delegation preferences (data):\n')[1]);

describe('shared delegation preferences', () => {
  test('uses conservative, unsaved defaults with localized enum choices', () => {
    const pack = createDelegationPack(() => db);
    expect(facts(pack)).toEqual(
      Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [key, { value, configured: false }])
      )
    );
    for (const [key, declaration] of Object.entries(pack.preferences!)) {
      expect(declaration.scope).toBe('global');
      expect(declaration.default).toBe(defaults[key as keyof typeof defaults]);
      expect(declaration.type.kind).toBe('enum');
      if (declaration.type.kind !== 'enum') throw new Error('Expected enum');
      expect(declaration.type.values[0]).toBe(declaration.default);
      expect(declaration.label['zh-Hans']).toBeTruthy();
      for (const value of declaration.type.values)
        expect(declaration.valueLabels[value]['zh-Hans']).toBeTruthy();
    }
    expect(db.prepare('SELECT count(*) AS n FROM neo_pack_preferences').get()).toEqual({ n: 0 });
  });

  test.each([[], ['coding']])('remains available with an explicit pack list %j', (enabled) => {
    const pack = createDelegationPack(() => db);
    expect(neoPacks({ builtins: [pack], filePacks: [], enabled })).toEqual([pack]);
    expect(neoPackBriefs(enabled, [pack])).toEqual([pack]);
  });

  test('Neo sees the current values after a human setting changes', async () => {
    const pack = createDelegationPack(() => db);
    const set = createPackPreferenceOperations(db, () => [pack]).find(
      (op) => op.name === 'pack.preferences.set'
    )!;
    await set.execute(
      set.inputSchema.parse({
        pack: 'delegation',
        scope: { kind: 'global', key: '' },
        key: 'humanStep',
        value: 'phoneOnly',
      }),
      { source: 'rpc', principal: 'local' }
    );
    expect(facts(pack).humanStep).toEqual({ value: 'phoneOnly', configured: true });
    const prompt = neoPrompt([pack]);
    expect(prompt).toContain('"humanStep":{"value":"phoneOnly","configured":true}');
    expect(prompt).not.toContain('For an expired sign-in, use available browser');
    expect(pack.instructions()).toContain('the saved password manager or browser autofill');
    expect(pack.instructions()).toContain('CAPTCHAs always belong to the human');
  });

  test('refuses unsupported values and non-global scopes', () => {
    const pack = createDelegationPack(() => db);
    const setting = {
      pack: 'delegation',
      scope: { kind: 'global' as const, key: '' },
      key: 'payment',
      value: 'direct',
    };
    expect(validatePackPreference(setting, [pack])).toHaveProperty('reason');
    expect(
      validatePackPreference(
        { ...setting, value: 'self', scope: { kind: 'repo', key: 'example/repo' } },
        [pack]
      )
    ).toHaveProperty('reason');
  });
});
