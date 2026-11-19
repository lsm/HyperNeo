import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import type { RateLimitHoldReason } from '@hyperneo/shared';
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

const Repositories = z.array(z.string().regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i));
const Names = z.array(z.string().min(1));
const Line = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    harness: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  })
  .strict();
const LineFilter = z
  .object({ kinds: Names.optional(), repos: Repositories.optional(), projects: Names.optional() })
  .strict();
const Routes = z.array(
  z
    .object({
      kind: z.string().min(1),
      repos: Repositories.optional(),
      lines: z.array(Line.extend({ stopAtPercent: z.number().min(0).max(100).optional() })).min(1),
    })
    .strict()
);
const LineRules = z.array(
  z.object({ line: Line, only: LineFilter.optional(), never: LineFilter.optional() }).strict()
);
const HoldRules = z.array(
  z
    .object({
      reason: z.enum(['network', 'login', 'limit', 'overloaded'] satisfies RateLimitHoldReason[]),
      line: Line.optional(),
      action: z.enum(['wait', 'move']),
      afterMinutes: z.number().finite().min(0),
    })
    .strict()
);

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
    case 'repositories':
      return Repositories;
    case 'globs':
      return Names;
    case 'text':
      return z.string().max(200);
    case 'login':
      return z.string().regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i);
    case 'routes':
      return Routes;
    case 'lineRules':
      return LineRules;
    case 'holdRules':
      return HoldRules;
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

function isDeclaredPreference(packs: readonly NeoPack[], pack: string, key: string): boolean {
  const preferences = packs.find((item) => item.id === pack)?.preferences;
  return preferences !== undefined && Object.hasOwn(preferences, key);
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

export type PackPreferenceChange = Input & { before: unknown };

export function createPackPreferenceOperations(
  db: Database,
  packs: () => readonly NeoPack[],
  changed?: (change: PackPreferenceChange) => Promise<void>
) {
  const save = db.transaction((input: Input): PackPreferenceChange | undefined => {
    const { pack, scope, key, value } = input;
    const saved = getNeoPackPreference(db, pack, scope, key);
    const before =
      saved?.scope.kind === scope.kind && saved.scope.key === scope.key ? saved.value : undefined;
    const json = JSON.stringify(value);
    if (JSON.stringify(before) === json) return;

    db.prepare(`INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES (?, ?, ?, ?, ?, 'human', ?) ON CONFLICT (pack, scope_kind, scope_key, key)
      DO UPDATE SET value_json=excluded.value_json, set_by=excluded.set_by, set_at=excluded.set_at`).run(
      pack,
      scope.kind,
      scope.key,
      key,
      json,
      Date.now()
    );
    return { ...input, before };
  }, 'immediate');
  const set = (superpipe({})('pack.preferences.set') as PipelineAPI)
    .input(['input'])
    .pipe((input: Input) => validatePackPreference(input, packs()), 'input', 'result:setting')
    .pipe(
      async (input: Input) => {
        const change = save(input);
        if (change) await changed?.(change);
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
        const saved = isDeclaredPreference(packs(), input.pack, input.key)
          ? getNeoPackPreference(db, input.pack, input.scope, input.key)
          : null;
        return { preference: saved ? { ...saved, pack: input.pack, key: input.key } : null };
      },
      'input',
      'output'
    )
    .endAsync('output');
  const list = (superpipe({})('pack.preferences.list') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: { pack?: string }) => {
        const currentPacks = packs();
        return {
          preferences: listPackPreferences(db, input.pack).filter((setting) =>
            isDeclaredPreference(currentPacks, setting.pack, setting.key)
          ),
          declarations: currentPacks.find((pack) => pack.id === input.pack)?.preferences ?? {},
        };
      },
      'input',
      'output'
    )
    .endAsync('output');
  return [
    defineOperation({
      name: 'pack.preferences.set',
      description: neoToolDescription('pack.preferences.set'),
      inputSchema: PackPreferenceInput,
      resultSchema: Result,
      policy: { safetyClass: 'human_only', caller: 'local_user' },
      execute: set,
    }),
    defineOperation({
      name: 'pack.preferences.get',
      description: neoToolDescription('pack.preferences.get'),
      inputSchema: Address,
      resultSchema: z.object({ preference: PackSettingSchema.nullable() }),
      policy: { safetyClass: 'read' },
      execute: get,
    }),
    defineOperation({
      name: 'pack.preferences.list',
      description: neoToolDescription('pack.preferences.list'),
      inputSchema: z.object({ pack: z.string().optional() }),
      resultSchema: z.object({
        preferences: z.array(PackSettingSchema),
        declarations: z.record(
          z.string(),
          z.object({
            label: z.object({ en: z.string(), 'zh-Hans': z.string() }),
            valueLabels: z.record(z.string(), z.object({ en: z.string(), 'zh-Hans': z.string() })),
          })
        ),
      }),
      policy: { safetyClass: 'read' },
      execute: list,
    }),
  ];
}
