import type { RateLimitHoldReason } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { readProviderUsage } from '../../../rpc-handlers/family-operations/settings.ts';
import type { NeoAttentionEvent } from '../../attention/decide.ts';
import type {
  NeoLine,
  NeoLineRanking,
  NeoLineScope,
  NeoPack,
  NeoPackBrief,
  NeoPackPreferenceDeclaration,
} from '../../pack-contract.ts';
import { getNeoPackPreference } from '../../preferences.ts';
import { DEFAULT_ON_HOLD, type HeldLine, type HoldRule, lineHeldText, onLineHeld } from './held.ts';
import {
  type Availability,
  type LineHold,
  type LineRule,
  type RankInput,
  type Route,
  names,
  rankLines,
  routeFor,
  type UsageReading,
} from './rank.ts';

const PACK = 'model-routing';
const LINE_HELD = `${PACK}.line_held`;

const listPreference = (
  kind: 'routes' | 'lineRules' | 'holdRules',
  en: string,
  zh: string,
  value: readonly unknown[] = []
): NeoPackPreferenceDeclaration => ({
  label: { en, 'zh-Hans': zh },
  valueLabels: {},
  scope: 'global',
  type: { kind },
  default: value,
  ask: en,
});

const preferences = {
  routes: listPreference(
    'routes',
    'Which lines does each kind of work prefer?',
    '各类工作优先用哪些模型线路？'
  ),
  rules: listPreference('lineRules', 'Where may each line be used?', '每条线路可以用在哪里？'),
  onHold: listPreference(
    'holdRules',
    'When a worker is held on a line, how long should it wait before Neo hears?',
    '工作者被某条线路挡住时，等多久再告诉 Neo？',
    DEFAULT_ON_HOLD
  ),
};

export const MODEL_ROUTING_PACK_BRIEF: NeoPackBrief = {
  id: PACK,
  describe:
    'Ranks model lines (provider, model, harness, effort) for a kind of work by the human’s routes and rules, current holds, usage and sign-in.',
};

export interface ModelRoutingDeps {
  database: () => Database;
  provider: (providerId: string) => Provider | undefined;
  now?: () => number;
}

const readPreference = (db: Database, key: keyof typeof preferences) =>
  getNeoPackPreference(db, PACK, { kind: 'global', key: '' }, key)?.value ??
  preferences[key].default;

function readPrefs(db: Database): RankInput['prefs'] {
  return {
    routes: readPreference(db, 'routes') as Route[],
    rules: readPreference(db, 'rules') as LineRule[],
  };
}

type HeldTodo = {
  todo: { id: string; title: string; named: string | null };
  worker: string;
  hold: HeldLine;
};

function readHeldTodos(db: Database, now: number): HeldTodo[] {
  return db
    .prepare(`SELECT t.id, t.title, t.named, x.id AS worker,
        json_extract(x.config, '$.provider') AS provider,
        json_extract(x.config, '$.model') AS model,
        json_extract(x.processing_state, '$.reason') AS reason,
        json_extract(x.processing_state, '$.since') AS since,
        json_extract(x.processing_state, '$.retryAt') AS retryAt
      FROM neo_todos t
      JOIN neo_todo_sessions s ON s.todo_id = t.id AND json_valid(s.ref)
      JOIN sessions x ON x.id = json_extract(s.ref, '$.id')
      WHERE t.state = 'doing'
        AND json_extract(s.ref, '$.adapter') = 'hyperneo' AND json_extract(s.ref, '$.daemon') IS NULL
        AND x.status NOT IN ('archived', 'ended') AND x.archived_at IS NULL
        AND json_valid(x.processing_state) AND json_valid(x.config)
        AND json_extract(x.processing_state, '$.status') = 'rate_limit_cooldown'
        AND (json_extract(x.processing_state, '$.reason') = 'login'
          OR json_extract(x.processing_state, '$.retryAt') IS NULL
          OR json_extract(x.processing_state, '$.retryAt') > ?)`)
    .all(now)
    .flatMap((row) => {
      const { id, title, named, worker, provider, model, reason, since, retryAt } = row as Record<
        string,
        unknown
      >;
      return typeof provider === 'string' &&
        typeof model === 'string' &&
        typeof reason === 'string' &&
        typeof since === 'number'
        ? [
            {
              todo: { id: String(id), title: String(title), named: named as string | null },
              worker: String(worker),
              hold: {
                line: { provider, model, harness: 'hyperneo' },
                reason: reason as RateLimitHoldReason,
                since,
                ...(typeof retryAt === 'number' ? { retryAt } : {}),
              },
            },
          ]
        : [];
    });
}

function workOf(named: string | null): { kind: string; scope: NeoLineScope } {
  const facts = (named ? JSON.parse(named) : {}) as Record<string, unknown>;
  return {
    kind: typeof facts.workKind === 'string' ? facts.workKind : 'general',
    scope: typeof facts.repository === 'string' ? { repo: facts.repository } : {},
  };
}

function readHolds(db: Database): LineHold[] {
  return db
    .prepare(`SELECT json_extract(config, '$.provider') AS provider,
        json_extract(config, '$.model') AS model,
        json_extract(processing_state, '$.reason') AS reason,
        json_extract(processing_state, '$.retryAt') AS retryAt
      FROM sessions
      WHERE status NOT IN ('archived', 'ended') AND archived_at IS NULL
        AND json_valid(processing_state) AND json_valid(config)
        AND json_extract(processing_state, '$.status') = 'rate_limit_cooldown'`)
    .all()
    .flatMap((row) => {
      const { provider, model, reason, retryAt } = row as Record<string, unknown>;
      return typeof provider === 'string' &&
        typeof model === 'string' &&
        typeof retryAt === 'number'
        ? [{ provider, model, retryAt, ...(typeof reason === 'string' ? { reason } : {}) }]
        : [];
    });
}

async function readAvailability(provider: Provider | undefined): Promise<Availability> {
  if (!provider) return 'not configured';
  const status = await provider.getAuthStatus?.();
  if (status && !status.isAuthenticated) return 'not signed in';
  return (await provider.isAvailable()) ? 'ready' : 'not configured';
}

export function createModelRoutingPack(deps: ModelRoutingDeps): NeoPack {
  const now = deps.now ?? Date.now;
  const readings = new Map<string, UsageReading>();
  const providers = (candidates: readonly NeoLine[]) => [
    ...new Set(candidates.map((line) => line.provider)),
  ];

  const readUsage = async (candidates: readonly NeoLine[]) => {
    for (const id of providers(candidates)) {
      const result = await readProviderUsage({ providerId: id }, deps).catch(() => null);
      if (result) readings.set(id, { result, readAt: now() });
    }
    return Object.fromEntries(readings);
  };

  const availability = async (candidates: readonly NeoLine[]) =>
    Object.fromEntries(
      await Promise.all(
        providers(candidates).map(
          async (id) =>
            [id, await readAvailability(deps.provider(id)).catch(() => 'not configured')] as const
        )
      )
    );

  const rank = (superpipe({})('model-routing.rank-lines') as PipelineAPI)
    .input(['kind', 'candidates', 'scope'])
    .pipe(() => readPrefs(deps.database()), 'kind', 'prefs')
    .pipe(() => readHolds(deps.database()), 'kind', 'holds')
    .pipe(readUsage, 'candidates', 'usage')
    .pipe(availability, 'candidates', 'availability')
    .pipe(() => now(), 'kind', 'now')
    .pipe(
      (
        kind: string,
        candidates: readonly NeoLine[],
        scope: NeoLineScope,
        prefs: RankInput['prefs'],
        holds: LineHold[],
        usage: RankInput['usage'],
        available: RankInput['availability'],
        at: number
      ) =>
        rankLines({
          kind,
          candidates,
          scope,
          prefs,
          holds,
          usage,
          availability: available,
          now: at,
        }),
      ['kind', 'candidates', 'scope', 'prefs', 'holds', 'usage', 'availability', 'now'],
      'ranking'
    )
    .endAsync('ranking') as (
    kind: string,
    candidates: readonly NeoLine[],
    scope: NeoLineScope
  ) => Promise<NeoLineRanking>;

  const scan = (superpipe({})('model-routing.line-held') as PipelineAPI)
    .input(['now'])
    .pipe((at: number) => readHeldTodos(deps.database(), at), 'now', 'held')
    .pipe(() => readPreference(deps.database(), 'onHold'), 'now', 'rules')
    .pipe(() => readPrefs(deps.database()).routes, 'now', 'routes')
    .pipe(
      (held: HeldTodo[], routes: Route[]) => {
        const rankings = new Map<string, Promise<NeoLineRanking>>();
        return Promise.all(
          held.map(async (entry) => {
            const { kind, scope } = workOf(entry.todo.named);
            const route = routeFor(routes, kind, scope);
            const others = (route?.lines ?? []).filter((line) => !names(line, entry.hold.line));
            const key = JSON.stringify([kind, scope, entry.hold.line]);
            if (!rankings.has(key)) rankings.set(key, rank(kind, others, scope));
            const ranking = await rankings.get(key)!;
            return {
              ...entry,
              others,
              ranking: { ...ranking, exhausted: !!route && ranking.ranked.length === 0 },
            };
          })
        );
      },
      ['held', 'routes'],
      'ranked'
    )
    .pipe(
      (ranked: unknown[], at: number) => (ranked.length ? readHeldTodos(deps.database(), at) : []),
      ['ranked', 'now'],
      'current'
    )
    .pipe(
      (
        ranked: (HeldTodo & { others: NeoLine[]; ranking: NeoLineRanking })[],
        current: HeldTodo[],
        rules: HoldRule[],
        at: number
      ): NeoAttentionEvent[] =>
        ranked.flatMap(({ todo, worker, hold, others, ranking }) =>
          current.some(
            (live) =>
              live.todo.id === todo.id && live.worker === worker && live.hold.since === hold.since
          ) && onLineHeld({ hold, rules, ranking, now: at }).action === 'tellNeo'
            ? [
                {
                  kind: LINE_HELD,
                  subject: { type: 'todo', id: todo.id },
                  since: hold.since,
                  facts: { text: lineHeldText(todo, hold, others) },
                },
              ]
            : []
        ),
      ['ranked', 'current', 'rules', 'now'],
      'events'
    )
    .endAsync('events') as (now: number) => Promise<NeoAttentionEvent[]>;

  return {
    ...MODEL_ROUTING_PACK_BRIEF,
    preferences,
    rankLines: rank,
    attention: {
      kinds: [{ id: LINE_HELD, decide: () => 'wake', render: ({ facts }) => String(facts.text) }],
      scan,
    },
    instructions: () => null,
  };
}
