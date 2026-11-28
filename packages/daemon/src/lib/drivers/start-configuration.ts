import { THINKING_OPTIONS } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';

const Schema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(100).optional(),
});
const RefusalSchema = z.enum(['unsupported_model', 'unsupported_effort', 'identity_required']);
type Request = z.infer<typeof Schema>;
interface Model {
  id: string;
  aliases?: readonly string[];
  efforts: readonly string[];
  isDefault?: boolean;
}
type Gate<T> =
  | { value: T }
  | { reason: { ok: false; reason: z.infer<typeof RefusalSchema>; detail: string } };
const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
export function resolveHyperneoThinking(value: string | undefined) {
  if (value === undefined) return undefined;
  const effort = normalized(value);
  return THINKING_OPTIONS.find(
    (entry) => entry.value === effort || entry.label.toLowerCase() === effort
  );
}

const refuse = (reason: z.infer<typeof RefusalSchema>, detail: string): Gate<never> => ({
  reason: { ok: false, reason, detail },
});

function selectModel(request: Request, models: readonly Model[]): Gate<Model | null> {
  if (request.model === undefined && request.effort === undefined) return { value: null };
  const name = request.model === undefined ? null : normalized(request.model);
  const exact = models.filter((model) => model.id === request.model);
  const candidates = exact.length
    ? exact
    : models.filter((model) =>
        name === null
          ? model.isDefault === true
          : normalized(model.id) === name ||
            model.aliases?.some((alias) => normalized(alias) === name)
      );
  return candidates.length === 1
    ? { value: candidates[0] }
    : refuse(
        request.model === undefined ? 'unsupported_effort' : 'unsupported_model',
        candidates.length
          ? 'The requested model or catalog default is ambiguous; choose an exact model ID.'
          : `No supported model matches ${JSON.stringify(request.model ?? 'the catalog default')}.`
      );
}

function selectEffort(request: Request, model: Model | null): Gate<Request> {
  if (!model) return { value: {} };
  const effort = request.effort === undefined ? undefined : normalized(request.effort);
  const matches = model.efforts.filter((candidate) => normalized(candidate) === effort);
  return effort !== undefined && matches.length !== 1
    ? refuse(
        'unsupported_effort',
        `Model ${model.id} does not uniquely support effort ${JSON.stringify(request.effort)}.`
      )
    : { value: { model: model.id, ...(effort === undefined ? {} : { effort: matches[0] }) } };
}

const select = (superpipe({})('work-start-configuration') as PipelineAPI)
  .input(['request', 'models'])
  .pipe(selectModel, ['request', 'models'], 'result:configuration')
  .pipe(selectEffort, ['request', 'configuration'], 'result:configuration')
  .end('configuration') as (
  request: Request,
  models: readonly Model[]
) =>
  | Request
  | {
      ok: false;
      reason: z.infer<typeof RefusalSchema>;
      detail: string;
    };

export interface IdentityFacts {
  fixedProvider?: string;
  catalogProvider?: string;
  configurable: boolean;
}
interface IdentityRequest extends Request {
  adapter: string;
  provider?: string;
}
export interface Identity {
  provider: string;
  model: string;
  effort: string;
}

function agreeProvider(request: IdentityRequest, facts: IdentityFacts): Gate<string | null> {
  const named = [
    [`adapter ${request.adapter} runs on provider`, facts.fixedProvider],
    ['the model catalog names provider', facts.catalogProvider],
    ['the request names provider', request.provider],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  const clash = named.find(([, provider]) => provider !== named[0][1]);
  return clash
    ? refuse(
        'identity_required',
        `identity_required: ${named[0][0]} ${named[0][1]}, not ${clash[1]}`
      )
    : { value: named[0]?.[1] ?? null };
}

function requireTriple(request: IdentityRequest, provider: string | null): Gate<Identity> {
  const missing = [
    ...(provider === null ? ['provider'] : []),
    ...(request.model === undefined ? ['model'] : []),
    ...(request.effort === undefined ? ['effort'] : []),
  ];
  return provider === null || request.model === undefined || request.effort === undefined
    ? refuse(
        'identity_required',
        `identity_required: name provider, model and effort for new work (missing: ${missing.join(', ')})`
      )
    : { value: { provider, model: request.model, effort: request.effort } };
}

const requireIdentity = (superpipe({})('work-start-identity') as PipelineAPI)
  .input(['request', 'facts'])
  .pipe(agreeProvider, ['request', 'facts'], 'result:identity')
  .pipe(requireTriple, ['request', 'identity'], 'result:identity')
  .end('identity') as (
  request: IdentityRequest,
  facts: IdentityFacts
) => Identity | { ok: false; reason: z.infer<typeof RefusalSchema>; detail: string };

type Receipt =
  | { ok: true; value: Request }
  | { ok: false; reason: 'not_delivered'; detail: string };

function confirmField(
  field: keyof Request,
  requested: Request,
  observed: Request
): { value: Request } | { reason: Extract<Receipt, { ok: false }> } {
  return requested[field] === undefined || requested[field] === observed[field]
    ? { value: observed }
    : {
        reason: {
          ok: false,
          reason: 'not_delivered',
          detail: `The driver did not confirm ${field} ${JSON.stringify(requested[field])}; reported ${JSON.stringify(observed[field] ?? null)}.`,
        },
      };
}

const confirm = (superpipe({})('work-start-configuration-receipt') as PipelineAPI)
  .input(['requested', 'observed'])
  .pipe(
    (requested: Request, observed: Request) => confirmField('model', requested, observed),
    ['requested', 'observed'],
    'result:configuration'
  )
  .pipe(
    (requested: Request, observed: Request) => confirmField('effort', requested, observed),
    ['requested', 'configuration'],
    'result:configuration'
  )
  .pipe(
    (observed: Request): Receipt => ({ ok: true, value: { ...observed } }),
    'configuration',
    'configuration'
  )
  .end('configuration') as (requested: Request, observed: Request) => Receipt;

export const workStartConfiguration = {
  normalize: normalized,
  schema: Schema,
  refusalSchema: RefusalSchema,
  select,
  confirm,
  requireIdentity,
};
