import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { StartWorkInputSchema } from '../../../drivers/work-operations.ts';
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
  candidates: z
    .array(CodingStageTarget)
    .min(1)
    .max(30)
    .meta({ aliases: ['targets'] }),
  body: z.string().default(''),
});
type Plan = z.infer<typeof Plan>;
type Target = z.infer<typeof CodingStageTarget>;
type Preference = Partial<Record<'harness' | 'model' | 'effort', string>>;
type Choice = { target: Target; fallback: string[] };
type Result = { ok: true; choices: Choice[] } | { ok: false; reason: string };

export const CODING_STAGE_PREFERENCES: Record<string, NeoPackPreferenceDeclaration> =
  Object.fromEntries(
    (['write', 'review', 'verify'] as const).flatMap((stage) =>
      (['harness', 'effort'] as const).map((field) => [
        `${stage}.${field}`,
        {
          label: {
            en: `${stage[0].toUpperCase() + stage.slice(1)}: preferred ${field}`,
            'zh-Hans': `${{ write: '编写', review: '审查', verify: '验证' }[stage]}：优先${{ harness: '工具', model: '模型', effort: '思考等级' }[field]}`,
          },
          question: {
            en: `Which ${field} should ${stage} prefer?`,
            'zh-Hans': `${{ write: '编写', review: '审查', verify: '验证' }[stage]}优先使用哪个${{ harness: '工具', model: '模型', effort: '思考等级' }[field]}？`,
          },
          valueLabels: { '': { en: 'Default', 'zh-Hans': '默认' } },
          valueDescriptions: { '': { en: 'Use the default.', 'zh-Hans': '使用默认设置。' } },
          scope: 'repo',
          type: { kind: 'text' },
          default: '',
          ask: `Which ${field} should ${stage} prefer? Leave empty for the default; unavailable preferences fall back with an explanation.`,
        },
      ])
    )
  );

export const CODING_REVIEW_AFTER_PREFERENCE: NeoPackPreferenceDeclaration = {
  label: { en: 'Review: start automatically', 'zh-Hans': '审查：自动开始' },
  valueLabels: {
    never: { en: 'Never', 'zh-Hans': '不自动' },
    approved: { en: 'After review bot approval', 'zh-Hans': '审查机器人批准后' },
  },
  valueDescriptions: {
    never: { en: 'Neo starts a review only when asked.', 'zh-Hans': '只有被要求时 Neo 才开审查。' },
    approved: {
      en: 'When the review bot approves a head, Neo is told to start a coding.review worker for it.',
      'zh-Hans': '审查机器人批准某个提交后，提醒 Neo 开一个审查工作者。',
    },
  },
  scope: 'repo',
  type: { kind: 'enum', values: ['never', 'approved'] },
  default: 'never',
  question: {
    en: 'When should a review start automatically?',
    'zh-Hans': '什么时候自动开始审查？',
  },
  ask: 'Start a review automatically after the review bot approves a head? The reviewer line follows the coding.review routes; whether it holds the merge stays with crossModelReview.',
};

function codingRepoPreference(db: Database, repo: string, key: string): string {
  const scope = db
    .prepare(
      "SELECT scope_key FROM neo_pack_preferences WHERE pack = 'coding' AND scope_kind = 'repo' AND scope_key = ? COLLATE NOCASE AND key = ?"
    )
    .get(repo, key) as { scope_key: string } | undefined;
  const value = getNeoPackPreference(
    db,
    'coding',
    { kind: 'repo', key: scope?.scope_key ?? repo },
    key
  )?.value;
  return typeof value === 'string' ? value.trim() : '';
}

export const codingReviewAfter = (db: Database, repo: string) =>
  codingRepoPreference(db, repo, 'review.after') || 'never';

export function codingStagePreference(
  db: Database,
  input: Pick<Plan, 'repo' | 'stage'>
): Preference {
  return Object.fromEntries(
    (['harness', 'model', 'effort'] as const).map((field) => [
      field,
      codingRepoPreference(db, input.repo, `${input.stage}.${field}`),
    ])
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
  .pipe(codingStagePreference, ['db', 'input'], 'preference')
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
    ): Result => ({
      ok: true,
      choices: [...selection]
        .sort(
          (a, b) =>
            score(b.target, preference) - score(a.target, preference) ||
            Number(b.policy.preferred) - Number(a.policy.preferred)
        )
        .map(({ target }) => ({
          target,
          fallback: (['harness', 'model', 'effort'] as const).flatMap((field) =>
            preference[field] && fieldValue(target, field) !== preference[field]
              ? [
                  `Preferred ${field} ${JSON.stringify(preference[field])} is unavailable for this selection; using ${JSON.stringify(fieldValue(target, field) ?? 'default')}.`,
                ]
              : []
          ),
        })),
    }),
    ['selection', 'preference'],
    'selection'
  )
  .end('selection') as (db: Database, input: Plan, provenance: boolean) => Result;
