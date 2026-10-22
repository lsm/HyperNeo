import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

type Failure = { ok: false; reason: string };
export type NeoGithubLister = (
  args: string[],
  coverage: NeoGithubCollection
) => Promise<unknown | null>;

const When = z.string().datetime({ offset: true });

export const NeoGithubQuery = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'repo is owner/name'),
  kind: z.enum(['pr', 'issue']).default('pr'),
  state: z.enum(['open', 'merged', 'closed', 'all']).default('all'),
  by: z.enum(['created', 'updated', 'merged', 'closed']).optional(),
  since: When.optional(),
  until: When.optional(),
  withinHours: z.number().int().min(1).max(720).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type NeoGithubQuery = z.infer<typeof NeoGithubQuery>;

const Item = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable().default(null),
  closedAt: z.string().nullable().default(null),
});

export const NeoGithubQueryItems = z.array(Item);

export const NeoGithubQueryResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    kind: z.literal('list'),
    repo: z.string(),
    search: z.string(),
    window: z.object({
      by: z.enum(['created', 'updated', 'merged', 'closed']),
      since: z.string().nullable(),
      until: z.string(),
    }),
    items: z.array(Item),
    truncated: z.boolean(),
  }),
]);
export type NeoGithubQueryResult = z.infer<typeof NeoGithubQueryResult>;

type By = 'created' | 'updated' | 'merged' | 'closed';
export type NeoGithubCollection = Omit<NeoGithubQuery, 'withinHours' | 'by'> & { by: By };
type Plan = { query: NeoGithubQuery; by: By; search: string; args: string[] };

export function planNeoGithubQuery(
  input: NeoGithubQuery,
  now = Date.now()
): { value: Plan } | { reason: Failure } {
  if (input.withinHours && (input.since || input.until))
    return {
      reason: {
        ok: false,
        reason: 'one_window: pass withinHours alone, or since and until, not both.',
      },
    };
  const query = input.withinHours
    ? { ...input, since: new Date(now - input.withinHours * 3_600_000).toISOString() }
    : input;
  const by: By =
    query.by ??
    (query.state === 'merged' ? 'merged' : query.state === 'closed' ? 'closed' : 'created');
  if (query.kind === 'issue' && (query.state === 'merged' || by === 'merged'))
    return {
      reason: {
        ok: false,
        reason: 'issues_do_not_merge: list issues by created, updated or closed.',
      },
    };
  if (query.since && query.until && Date.parse(query.since) > Date.parse(query.until))
    return { reason: { ok: false, reason: 'empty_window: since is after until.' } };
  const window =
    query.since && query.until
      ? `${by}:${query.since}..${query.until}`
      : query.since
        ? `${by}:>=${query.since}`
        : query.until
          ? `${by}:<=${query.until}`
          : '';
  const fields =
    query.kind === 'pr'
      ? 'number,title,url,state,createdAt,updatedAt,mergedAt,closedAt'
      : 'number,title,url,state,createdAt,updatedAt,closedAt';
  return {
    value: {
      query,
      by,
      search: window,
      args: [
        'gh',
        query.kind,
        'list',
        '--repo',
        query.repo,
        '--state',
        query.state,
        '--limit',
        String(query.limit + 1),
        '--json',
        fields,
        ...(window ? ['--search', window] : []),
      ],
    },
  };
}

export function presentNeoGithubQuery(
  plan: Plan,
  listed: { data: unknown | null; at: string }
): { value: NeoGithubQueryResult } | { reason: Failure } {
  const parsed = NeoGithubQueryItems.safeParse(listed.data);
  if (!parsed.success)
    return {
      reason: {
        ok: false,
        reason: `unreadable: ${plan.query.repo} could not be listed from GitHub just now (missing, private, or gh failed); say you cannot see it rather than guessing.`,
      },
    };
  const at = (item: z.infer<typeof Item>) =>
    Date.parse(
      (plan.by === 'merged'
        ? item.mergedAt
        : plan.by === 'closed'
          ? item.closedAt
          : plan.by === 'updated'
            ? item.updatedAt
            : null) ?? item.createdAt
    );
  const items = [...parsed.data].sort((a, b) => at(b) - at(a));
  return {
    value: {
      ok: true,
      kind: 'list',
      repo: plan.query.repo,
      search: plan.search,
      window: {
        by: plan.by,
        since: plan.query.since ?? null,
        until: plan.query.until ?? listed.at,
      },
      items: items.slice(0, plan.query.limit),
      truncated: items.length > plan.query.limit,
    },
  };
}

export async function listNeoGithub(
  args: string[],
  spawnImpl: SpawnFn = spawnProcess
): Promise<unknown | null> {
  const outcome = await runGhJson(args, homedir(), spawnImpl);
  return outcome.ok ? outcome.data : null;
}

export const queryNeoGithub = (superpipe({})('neo-github-query') as PipelineAPI)
  .input(['list', 'query'])
  .pipe(planNeoGithubQuery, 'query', 'result:query')
  .pipe(
    async (list: NeoGithubLister, plan: Plan) => {
      const data = await list(plan.args, { ...plan.query, by: plan.by });
      return { data, at: new Date().toISOString() };
    },
    ['list', 'query'],
    'listed'
  )
  .pipe(presentNeoGithubQuery, ['query', 'listed'], 'result:query')
  .endAsync('query') as (
  list: NeoGithubLister,
  query: NeoGithubQuery
) => Promise<NeoGithubQueryResult>;
