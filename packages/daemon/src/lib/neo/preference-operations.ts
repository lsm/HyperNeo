import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../../storage/sqlite-compat.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { getNeoPackPreference } from './preferences.ts';
import type { NeoPack, NeoPackPreferenceDeclaration } from './pack-contract.ts';

const Scope = z
  .object({ kind: z.enum(['global', 'repo', 'project']), key: z.string() })
  .refine((s) => (s.kind === 'global' ? s.key === '' : s.key.length > 0));
const Address = z.object({ pack: z.string().min(1), scope: Scope, key: z.string().min(1) });
export const PackPreferenceInput = Address.extend({ value: z.unknown() });
export const PackSettingSchema = Address.extend({
  value: z.unknown(),
  setBy: z.string(),
  setAt: z.number(),
});
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true) }),
]);
type Input = z.infer<typeof PackPreferenceInput>;

function valueSchema(type: NeoPackPreferenceDeclaration['type']): z.ZodType {
  switch (type.kind) {
    case 'enum':
      return z.string().refine((value) => type.values.includes(value));
    case 'boolean':
      return z.boolean();
    case 'number':
      return z
        .number()
        .finite()
        .refine(
          (n) =>
            (type.min === undefined || n >= type.min) && (type.max === undefined || n <= type.max)
        );
    case 'globs':
      return z.array(z.string().min(1));
    case 'login':
      return z.string().regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i);
  }
}

export function listPackPreferences(db: Database, pack?: string): NeoPackSetting[] {
  const rows = db
    .prepare(`SELECT pack, scope_kind, scope_key, key, value_json, set_by, set_at
    FROM neo_pack_preferences ${pack === undefined ? '' : 'WHERE pack = ?'}
    ORDER BY pack, scope_kind, scope_key, key`)
    .all(...(pack === undefined ? [] : [pack])) as {
    pack: string;
    scope_kind: NeoPackSetting['scope']['kind'];
    scope_key: string;
    key: string;
    value_json: string;
    set_by: string;
    set_at: number;
  }[];
  return rows.map((row) => ({
    pack: row.pack,
    scope: { kind: row.scope_kind, key: row.scope_key },
    key: row.key,
    value: JSON.parse(row.value_json),
    setBy: row.set_by,
    setAt: row.set_at,
  }));
}

export function validatePackPreference(input: Input, packs: readonly NeoPack[]) {
  const declarations = packs.find((pack) => pack.id === input.pack)?.preferences;
  const declaration =
    declarations && Object.hasOwn(declarations, input.key) ? declarations[input.key] : undefined;
  const valid =
    declaration &&
    (input.scope.kind === 'global' || declaration.scope === input.scope.kind) &&
    valueSchema(declaration.type).safeParse(input.value).success;
  return valid
    ? { value: input }
    : {
        reason: {
          ok: false as const,
          reason: 'Unknown setting, invalid scope or invalid value.',
        },
      };
}

export function createPackPreferenceOperations(db: Database, packs: () => readonly NeoPack[]) {
  const set = (superpipe({})('pack.preferences.set') as PipelineAPI)
    .input(['input'])
    .pipe((input: Input) => validatePackPreference(input, packs()), 'input', 'result:setting')
    .pipe(
      (input: Input) => {
        db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
        VALUES (?, ?, ?, ?, ?, 'human', ?) ON CONFLICT (pack, scope_kind, scope_key, key)
        DO UPDATE SET value_json=excluded.value_json, set_by=excluded.set_by, set_at=excluded.set_at`).run(
          input.pack,
          input.scope.kind,
          input.scope.key,
          input.key,
          JSON.stringify(input.value),
          Date.now()
        );
        return { ok: true as const };
      },
      'setting',
      'setting'
    )
    .endAsync('setting') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<z.infer<typeof Result>>;
  const get = (superpipe({})('pack.preferences.get') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: z.infer<typeof Address>) => {
        const saved = getNeoPackPreference(db, input.pack, input.scope, input.key);
        return { preference: saved ? { ...saved, pack: input.pack, key: input.key } : null };
      },
      'input',
      'output'
    )
    .endAsync('output');
  const list = (superpipe({})('pack.preferences.list') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: { pack?: string }) => ({ preferences: listPackPreferences(db, input.pack) }),
      'input',
      'output'
    )
    .endAsync('output');
  return [
    defineOperation({
      name: 'pack.preferences.set',
      description:
        'Set a declared pack setting. Only the local human may write; agents cannot change settings.',
      inputSchema: PackPreferenceInput,
      resultSchema: Result,
      policy: { safetyClass: 'human_only', caller: 'local_user' },
      execute: set,
    }),
    defineOperation({
      name: 'pack.preferences.get',
      description: 'Read a setting at exact scope, then pack global. Missing is unanswered.',
      inputSchema: Address,
      resultSchema: z.object({ preference: PackSettingSchema.nullable() }),
      policy: { safetyClass: 'read' },
      execute: get,
    }),
    defineOperation({
      name: 'pack.preferences.list',
      description:
        'List saved pack settings with scope and human provenance. Missing defaults are never applied.',
      inputSchema: z.object({ pack: z.string().optional() }),
      resultSchema: z.object({ preferences: z.array(PackSettingSchema) }),
      policy: { safetyClass: 'read' },
      execute: list,
    }),
  ];
}
