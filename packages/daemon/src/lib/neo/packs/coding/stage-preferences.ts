import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { StartWorkInputSchema } from '../../../drivers/work-operations.ts';
import { defineOperation } from '../../../operations/registry.ts';
import type { NeoPackPreferenceDeclaration } from '../../pack-contract.ts';
import { getNeoPackPreference } from '../../preferences.ts';
import { codingReviewerPolicy } from './stage-facts.ts';

export const CodingStageTarget = StartWorkInputSchema.pick({
  adapter: true,
  place: true,
  model: true,
  effort: true,
});
const Plan = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/),
  stage: z.enum(['write', 'review', 'verify']),
  candidates: z.array(CodingStageTarget).min(1).max(30),
  body: z.string().default(''),
});
type Plan = z.infer<typeof Plan>;
type Target = z.infer<typeof CodingStageTarget>;
type Preference = Partial<Record<'harness' | 'model' | 'effort', string>>;
type Result = { ok: true; target: Target; fallback: string[] } | { ok: false; reason: string };

export const CODING_STAGE_PREFERENCES: Record<string, NeoPackPreferenceDeclaration> =
  Object.fromEntries(
    (['write', 'review', 'verify'] as const).flatMap((stage) =>
      (['harness', 'model', 'effort'] as const).map((field) => [
        `${stage}.${field}`,
        {
          label: {
            en: `${stage[0].toUpperCase() + stage.slice(1)}: preferred ${field}`,
            'zh-Hans': `${{ write: '编写', review: '审查', verify: '验证' }[stage]}：优先${{ harness: '工具', model: '模型', effort: '思考等级' }[field]}`,
          },
          valueLabels: { '': { en: 'Default', 'zh-Hans': '默认' } },
          scope: 'repo',
          type: { kind: 'text' },
          default: '',
          ask: `Which ${field} should ${stage} prefer? Leave empty for the default; unavailable preferences fall back with an explanation.`,
        },
      ])
    )
  );

function preferences(db: Database, input: Plan): Preference {
  return Object.fromEntries(
    (['harness', 'model', 'effort'] as const).map((field) => {
      const key = `${input.stage}.${field}`;
      const scope = db
        .prepare(
          "SELECT scope_key FROM neo_pack_preferences WHERE pack = 'coding' AND scope_kind = 'repo' AND scope_key = ? COLLATE NOCASE AND key = ?"
        )
        .get(input.repo, key) as { scope_key: string } | undefined;
      const value = getNeoPackPreference(
        db,
        'coding',
        { kind: 'repo', key: scope?.scope_key ?? input.repo },
        key
      )?.value;
      return [field, typeof value === 'string' ? value.trim() : ''];
    })
  );
}

const fieldValue = (target: Target, field: keyof Preference) =>
  field === 'harness' ? target.adapter : target[field];
const score = (target: Target, preference: Preference) =>
  (['harness', 'model', 'effort'] as const).reduce(
    (sum, field) =>
      sum + (preference[field] && fieldValue(target, field) === preference[field] ? 1 : 0),
    0
  );

export const planCodingStageTarget = (superpipe({})('coding.stage-target') as PipelineAPI)
  .input(['db', 'input', 'provenance'])
  .pipe(preferences, ['db', 'input'], 'preference')
  .pipe(
    (input: Plan, provenance: boolean) => {
      const eligible = input.candidates.map((target) => ({
        target,
        policy:
          input.stage === 'review'
            ? codingReviewerPolicy(provenance, input.body, {
                kind: 'agent',
                id: 'candidate',
                model: target.model ?? '',
                harness: target.adapter,
              })
            : { qualifies: true, preferred: false, reason: '' },
      }));
      return eligible.some((item) => item.policy.qualifies)
        ? { value: eligible.filter((item) => item.policy.qualifies) }
        : {
            reason: {
              ok: false,
              reason: `${eligible[0].policy.reason}: configure a qualifying reviewer.`,
            },
          };
    },
    ['input', 'provenance'],
    'result:selection'
  )
  .pipe(
    (
      selection: { target: Target; policy: { preferred: boolean } }[],
      preference: Preference
    ): Result => {
      const target = [...selection].sort(
        (a, b) =>
          score(b.target, preference) - score(a.target, preference) ||
          Number(b.policy.preferred) - Number(a.policy.preferred)
      )[0].target;
      return {
        ok: true,
        target,
        fallback: (['harness', 'model', 'effort'] as const).flatMap((field) =>
          preference[field] && fieldValue(target, field) !== preference[field]
            ? [
                `Preferred ${field} ${JSON.stringify(preference[field])} is unavailable for this selection; using ${JSON.stringify(fieldValue(target, field) ?? 'default')}.`,
              ]
            : []
        ),
      };
    },
    ['selection', 'preference'],
    'selection'
  )
  .end('selection') as (db: Database, input: Plan, provenance: boolean) => Result;

export function createCodingWritePlanOperation(database: () => Database) {
  return defineOperation({
    name: 'neo.coding.write.plan',
    description:
      'Choose a Write target from available adapter/place/model/effort configurations (first candidate is the default). Applies the same repository prefer settings used by Review and Verify; reports unavailable preferences without saving defaults. Use the returned target with the existing coding todo start. This read does not start work or change assignments.',
    inputSchema: Plan.omit({ stage: true, body: true }),
    resultSchema: z.union([
      z.object({ ok: z.literal(true), target: CodingStageTarget, fallback: z.array(z.string()) }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
    policy: { safetyClass: 'read', roles: ['neo'] },
    execute: async (input) =>
      planCodingStageTarget(database(), { ...input, stage: 'write', body: '' }, false),
  });
}
