import type { OperationCaller } from '../operations/registry.ts';
import type {
  NeoAsk,
  NeoAskItemKind,
  NeoAskQuestionBecause,
} from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { NEO_ASK_QUESTION_REASONS } from '@hyperneo/shared/types/neo-snapshot';
import { NeoAskStateViewSchema } from './card-view-schema.ts';
import { GITHUB_REF_PATH } from '../github/parse-pr-url.ts';
import { countNeoAskWatches, NEO_ASK_WATCH_MAX } from './packs/coding/watch-checks.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAskItemInput } from '../../storage/repositories/neo-ask-repository.ts';
import type { planNeoAskRestate } from './ask-plans.ts';

export type Rejection = { ok: false; reason: string };

export type Gate<T> = { value: T } | { reason: Rejection };

export type NeoAdmit = (
  caller: OperationCaller,
  name: string,
  projectId?: string | null
) => Gate<OperationCaller>;

export type AskReceipt = { ok: true; ask: NeoAsk };

export type AskOpened = AskReceipt & { packBriefing?: string };

const CheckKind = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A check kind registered by a loaded pack.');

const NEO_ASK_ITEM_KINDS = ['decision', 'action', 'approval', 'wait'] as const;

const NEO_ASK_ITEM_OUTCOME_KINDS = ['state', 'answer'] as const;

const Failure = z.object({ ok: z.literal(false), reason: z.string() });

export const NeoAskSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  approvedRevision: z.number().int().nonnegative().nullable().optional(),
  id: z.string(),
  requestKey: z.string(),
  projectId: z.string().nullable(),
  originSessionId: z.string(),
  originMessageId: z.string().nullable(),
  title: z.string(),
  ask: z.string(),
  doneWhen: z.string(),
  doneSource: z.string(),
  pack: z.string().nullable().optional(),
  approvedAt: z.number().nullable().optional(),
  approvedContinues: z.number().optional(),
  approvedUntil: z.number().optional(),
  approvedContinueLimit: z.number().optional(),
  pooled: z.boolean().optional(),
  approvalSpent: z.enum(['continues', 'expired']).nullable().optional(),
  stalledWorkIds: z.array(z.string()).optional(),
  summarized: z.literal(true).optional(),
  waitingItem: z.string().nullable().optional(),
  refused: z.string().nullable().optional(),
  refusedCount: z.number().int().nonnegative().optional(),
  status: z.enum(['open', 'waiting', 'achieved', 'abandoned', 'blocked']),
  outcome: z.string().nullable(),
  evidence: z.string().nullable().optional(),
  doneItems: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        state: z.enum(['pending', 'met', 'needs_you', 'reported']),
        evidence: z.string().nullable(),
        answer: z.object({ choice: z.string().nullable(), at: z.number() }).optional(),
        check: z.string().min(1).nullable(),
        verifiedDefinitionHash: z.string().nullable().optional(),
        deliveredBy: z.string().nullable().optional(),
        metBy: z.enum(['neo', 'daemon', 'human']).nullable(),
        removed: z.boolean(),
        removedReason: z.string().optional(),
        addedAt: z.number().nullable(),
        options: z.array(z.string()).optional(),
        decision: z.literal(true).optional(),
        action: z.string().optional(),
        waitCard: z.string().optional(),
        kind: z.enum(NEO_ASK_ITEM_KINDS).optional(),
        outcomeKind: z.enum(NEO_ASK_ITEM_OUTCOME_KINDS).optional(),
        question: z.string().optional(),
        decides: z.string().optional(),
        because: z
          .object({ card: z.string(), reason: z.enum(NEO_ASK_QUESTION_REASONS) })
          .optional(),
        watch: z.array(z.string()).optional(),
      })
    )
    .optional(),
  workIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  settledAt: z.number().nullable(),
});

export const AskResult = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    ask: NeoAskSchema,
    view: NeoAskStateViewSchema.nullable().optional(),
    packBriefing: z.string().optional(),
    note: z.string().optional(),
  }),
]);

const WatchUrl = z
  .string()
  .trim()
  .regex(
    new RegExp(`^https://${GITHUB_REF_PATH.source}$`),
    'Pass a GitHub pull request or issue URL.'
  );

const DeliveredBy = z.string().trim().min(1).nullable().optional();

const Item = z.object({
  deliveredBy: DeliveredBy.describe(
    'Stable card ID delivering this outcome. On open only an unlinked card from the same owner/project can be claimed; on edit use a card already on this ask.'
  ),
  text: z.string().trim().min(1).max(300),
  check: CheckKind.nullable()
    .optional()
    .describe(
      'A registered check kind the daemon ticks this item from, or null when you tick it yourself. Required.'
    ),
  watch: z.array(WatchUrl).min(1).max(10).optional(),
  outcomeKind: z
    .enum(NEO_ASK_ITEM_OUTCOME_KINDS)
    .default('state')
    .describe(
      'state: something in the world changes (merged, deployed, fixed, booked); it needs evidence you or the daemon can read. answer: the human asked to know something (a count, a list, an explanation); it is met when you publish the answer to them.'
    ),
});

export const Open = z
  .object({
    projectId: z.string().min(1).nullable().default(null),
    title: z.string().trim().min(1).max(160).describe('Use the human’s language.'),
    ask: z.string().trim().min(1).max(4000),
    doneWhen: z.string().trim().min(1).max(2000).optional(),
    doneItems: z.array(Item).min(1).optional(),
    doneSource: z.string().trim().min(1).max(160),
    pack: z.string().trim().min(1).max(80).optional(),
  })
  .refine((input) => input.doneWhen || input.doneItems, 'Pass doneItems, or doneWhen.')
  .refine(
    (input) => countNeoAskWatches(input.doneItems ?? []) <= NEO_ASK_WATCH_MAX,
    `An ask watches at most ${NEO_ASK_WATCH_MAX} pull requests and issues across its items.`
  );

export type OpenRequest = z.infer<typeof Open> & { requestKey: string };

export type Opening = Omit<OpenRequest, 'doneItems' | 'doneWhen'> & { doneWhen: string };

const Options = z
  .array(z.string().trim().min(1).max(80))
  .min(2)
  .max(4)
  .refine((options) => new Set(options).size === options.length, 'Options must differ.');

const Decides = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .describe(
    'A short stable name for the decision this question asks (e.g. "release date", "slice 6 target"). Asking the same decision again, however worded, restates its open question instead of adding another.'
  );

const Because = z
  .object({ card: z.string().min(1), reason: z.enum(NEO_ASK_QUESTION_REASONS) })
  .describe(
    "Why this question exists, when a card under this ask is the reason: target_unavailable (the card can't start because its target is gone), card_waits (the card waits on the human), card_failed (the card failed). The daemon withdraws the question as no longer needed once that reason is gone: the card's target resolves, the card stops waiting on the human, or the card is no longer failed."
  );

export const Settle = z.preprocess(
  (input) =>
    input && typeof input === 'object' && !('id' in input) && 'askId' in input
      ? { ...input, id: (input as { askId: unknown }).askId }
      : input,
  z
    .object({
      id: z.string().min(1),
      outcome: z.enum(['achieved', 'abandoned', 'blocked', 'waiting']),
      summary: z.string().trim().min(1).max(200).optional(),
      evidence: z.string().trim().min(1).max(4000),
      kind: z.enum(NEO_ASK_ITEM_KINDS).optional(),
      question: z.string().trim().min(1).max(200).optional(),
      decides: Decides.optional(),
      because: Because.optional(),
      options: Options.optional(),
    })
    .refine(
      (input) => !input.question === !input.options && !input.question === !input.decides,
      'Pass question, decides and options together: one question, the decision it asks, and 2-4 short answers.'
    )
);

const ExpectedRevision = z
  .number()
  .int()
  .nonnegative()
  .default(0)
  .describe('The revision from the current ask view; refresh after stale_revision.');

export const Tick = z.object({
  expectedRevision: ExpectedRevision,
  askId: z.string().min(1),
  itemId: z.string().min(1),
  state: z.enum(['pending', 'met', 'needs_you', 'reported']),
  evidence: z.string().trim().min(1).max(2000).optional(),
});

export const Question = z.object({
  askId: z.string().min(1),
  question: z.string().trim().min(1).max(200),
  decides: Decides,
  because: Because.optional(),
  options: z
    .union([z.tuple([]), Options])
    .default([])
    .describe(
      'Optional choices in display order: decline/negative first (left), agree/positive last (right). Omit or pass [] for an open question answered in chat.'
    ),
  kind: z.enum(NEO_ASK_ITEM_KINDS),
});

export const Answer = z.object({
  expectedRevision: ExpectedRevision,
  askId: z.string().min(1),
  itemId: z.string().min(1),
  choice: z.string().trim().min(1).max(1000),
  option: z.string().optional(),
  humanMessageId: z.string().min(1).max(200).optional(),
});

export const Approve = z.object({ askId: z.string().min(1), expectedRevision: ExpectedRevision });

export const Fold = z
  .object({ askId: z.string().min(1), intoAskId: z.string().min(1) })
  .refine((input) => input.askId !== input.intoAskId, 'Fold an ask into another ask.');

export const Edit = z
  .object({
    expectedRevision: ExpectedRevision,
    askId: z.string().min(1),
    add: z.array(Item).default([]),
    remove: z.array(z.string().min(1)).default([]),
    humanSaid: z.string().trim().min(1).max(500).optional(),
    bind: z
      .array(z.object({ itemId: z.string().min(1), deliveredBy: DeliveredBy.unwrap() }))
      .default([]),
    track: z
      .array(
        z
          .object({
            itemId: z.string().min(1),
            check: CheckKind.nullable().default(null),
            watch: z.array(WatchUrl).min(1).max(10).optional(),
          })
          .refine((item) => item.check || item.watch, 'Pass check or watch.')
      )
      .default([]),
  })
  .refine(
    (input) => input.add.length || input.remove.length || input.track.length || input.bind.length,
    'Pass items to add, remove, track or bind.'
  );

export type WorkAskInput = { askId?: string; projectId: string | null };

export type NeoAskNameable = { id: string; title: string; cardIds: string[]; refs: string[] };

export type NeoDaemonTicked = { ok: true; ask: NeoAsk; note: string };

export type NeoOutcomeCard = Pick<NeoWork, 'id' | 'status'>;

export type NeoAskQuestionItem = NeoAskItemInput & {
  id: string;
  position: number;
  kind: NeoAskItemKind;
  question: string;
  decides?: string;
  because?: NeoAskQuestionBecause;
  options: string[];
};

export type NeoAskSettleFacts = { offered: boolean; stalled: boolean; failed: boolean };

export type NeoAskSettlePlan = {
  waits: boolean;
  approval: boolean;
  item: NeoAskQuestionItem | null;
  restate: ReturnType<typeof planNeoAskRestate>;
  waitingItem: string | null;
};
