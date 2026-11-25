import { type RateLimitHoldReason, THINKING_OPTIONS } from '@hyperneo/shared';
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
  USAGE_STALE_MS,
  usageCurrent,
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
  question: { en, 'zh-Hans': zh },
  valueLabels: {},
  valueDescriptions: {},
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
  readDeadlineMs?: number;
}

const READ_DEADLINE_MS = 3_000;

function within<T>(promise: Promise<T>, ms: number, expired: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(expired), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
  told: { since: number; text: string; sent: boolean } | null;
  hold: HeldLine;
};

type Cooldown = Record<string, unknown>;

function readCooldowns(db: Database): Cooldown[] {
  return db
    .prepare(`SELECT t.id, t.title, t.named, x.id AS worker,
        json_extract(x.config, '$.provider') AS provider,
        json_extract(x.config, '$.model') AS model,
        json_extract(x.config, '$.thinkingLevel') AS thinkingLevel,
        json_extract(x.processing_state, '$.reason') AS reason,
        json_extract(x.processing_state, '$.since') AS since,
        json_extract(x.processing_state, '$.retryAt') AS retryAt,
        json_extract(x.processing_state, '$.manualRetry') AS manualRetry,
        json_extract(f.value_json, '$.since') AS told,
        json_extract(f.value_json, '$.text') AS toldText,
        json_extract(f.value_json, '$.sent') AS sent
      FROM sessions x
      LEFT JOIN neo_todo_sessions s ON json_valid(s.ref)
        AND json_extract(s.ref, '$.id') = x.id
        AND json_extract(s.ref, '$.adapter') = 'hyperneo' AND json_extract(s.ref, '$.daemon') IS NULL
      LEFT JOIN neo_todos t ON t.id = s.todo_id AND t.state = 'doing'
      LEFT JOIN pack_facts f ON f.todo_id = t.id AND f.pack = '${PACK}' AND f.key = 'told'
      WHERE x.status NOT IN ('archived', 'ended') AND x.archived_at IS NULL
        AND json_valid(x.processing_state) AND json_valid(x.config)
        AND json_extract(x.processing_state, '$.status') = 'rate_limit_cooldown'`)
    .all() as Cooldown[];
}

const effortOf = (level: unknown) => {
  const option = THINKING_OPTIONS.find((entry) => entry.value === level);
  return option ? { effort: option.label.toLowerCase() } : {};
};

const waitsOnSomeone = ({ reason, manualRetry }: Cooldown) =>
  reason === 'login' || manualRetry === 1;

function readHeldTodos(db: Database, now: number): HeldTodo[] {
  return readCooldowns(db).flatMap((row) => {
    const { id, title, named, worker, provider, model, reason, since, retryAt, told, toldText } =
      row;
    const live = waitsOnSomeone(row) || typeof retryAt !== 'number' || retryAt > now;
    return id !== null &&
      live &&
      typeof provider === 'string' &&
      typeof model === 'string' &&
      typeof reason === 'string' &&
      typeof since === 'number'
      ? [
          {
            todo: { id: String(id), title: String(title), named: named as string | null },
            worker: String(worker),
            told:
              typeof told === 'number'
                ? { since: told, text: String(toldText ?? ''), sent: row.sent === 1 }
                : null,
            hold: {
              line: { provider, model, harness: 'hyperneo', ...effortOf(row.thinkingLevel) },
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
  return readCooldowns(db).flatMap((row) => {
    const { provider, model, reason, retryAt } = row;
    const waiting = waitsOnSomeone(row) || typeof retryAt !== 'number';
    return typeof provider === 'string' && typeof model === 'string'
      ? [
          {
            provider,
            model,
            ...(typeof reason === 'string' ? { reason } : {}),
            ...(typeof retryAt === 'number' ? { retryAt } : {}),
            ...(waiting ? { waiting } : {}),
          },
        ]
      : [];
  });
}

type Access = { availability: Availability; owner: Provider | undefined; account?: string };

async function readAccess(provider: Provider | undefined): Promise<Access> {
  if (!provider) return { availability: 'not configured', owner: provider };
  const status = await provider.getAuthStatus?.();
  const account = `${status?.method ?? ''}:${status?.user?.email ?? status?.user?.name ?? ''}`;
  if (status && !status.isAuthenticated)
    return { availability: 'not signed in', owner: provider, account };
  return {
    availability: (await provider.isAvailable()) ? 'ready' : 'not configured',
    owner: provider,
    account,
  };
}

export function createModelRoutingPack(deps: ModelRoutingDeps): NeoPack {
  const now = deps.now ?? Date.now;
  const deadline = deps.readDeadlineMs ?? READ_DEADLINE_MS;
  const readings = new Map<string, UsageReading>();
  const providers = (candidates: readonly NeoLine[]) => [
    ...new Set(candidates.map((line) => line.provider)),
  ];

  const inflight = new Map<string, { read: Promise<void>; since: number }>();
  const owners = new Map<string, Omit<Access, 'availability'>>();
  const refresh = (id: string) => {
    const running = inflight.get(id);
    if (running && now() - running.since <= USAGE_STALE_MS) return running.read;
    const entry = { read: Promise.resolve(), since: now() };
    entry.read = readProviderUsage({ providerId: id }, deps)
      .then((result) => {
        if (result && inflight.get(id) === entry) readings.set(id, { result, readAt: now() });
      })
      .catch(() => {})
      .finally(() => {
        if (inflight.get(id) === entry) inflight.delete(id);
      });
    inflight.set(id, entry);
    return entry.read;
  };

  const readUsage = async (candidates: readonly NeoLine[], access: Record<string, Access>) => {
    for (const id of providers(candidates)) {
      const seen = access[id];
      const known = owners.get(id);
      const account = seen?.account ?? known?.account;
      if (known && known.owner === seen?.owner && known.account === account) continue;
      readings.delete(id);
      inflight.delete(id);
      owners.set(id, { owner: seen?.owner, account });
    }
    const stale = providers(candidates).filter((id) => !usageCurrent(readings.get(id), now()));
    await Promise.all(stale.map((id) => within(refresh(id), deadline, undefined)));
    return Object.fromEntries(readings);
  };

  const readAccesses = async (candidates: readonly NeoLine[]) =>
    Object.fromEntries(
      await Promise.all(
        providers(candidates).map(async (id) => {
          const owner = deps.provider(id);
          const access = await within(
            readAccess(owner).catch((): Access => ({ availability: 'not configured', owner })),
            deadline,
            { availability: 'availability unknown', owner }
          );
          return [id, access] as const;
        })
      )
    );

  const rank = (superpipe({})('model-routing.rank-lines') as PipelineAPI)
    .input(['kind', 'candidates', 'scope'])
    .pipe(() => readPrefs(deps.database()), 'kind', 'prefs')
    .pipe(() => readHolds(deps.database()), 'kind', 'holds')
    .pipe(readAccesses, 'candidates', 'access')
    .pipe(readUsage, ['candidates', 'access'], 'usage')
    .pipe(
      (access: Record<string, Access>) =>
        Object.fromEntries(Object.entries(access).map(([id, entry]) => [id, entry.availability])),
      'access',
      'availability'
    )
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
              ranking: { ...ranking, exhausted: !!route && ranking.ranked.length === 0 },
            };
          })
        );
      },
      ['held', 'routes'],
      'ranked'
    )
    .pipe(
      (
        ranked: (HeldTodo & { ranking: NeoLineRanking })[],
        rules: HoldRule[],
        at: number
      ): NeoAttentionEvent[] => {
        const current = ranked.length ? readHeldTodos(deps.database(), at) : [];
        return ranked.flatMap(({ todo, worker, hold, ranking }) => {
          const live = current.find(
            (entry) =>
              entry.todo.id === todo.id &&
              entry.worker === worker &&
              entry.hold.since === hold.since
          );
          if (!live) return [];
          const pending =
            live.told?.since === hold.since && !live.told.sent ? live.told.text : null;
          if (
            pending === null &&
            onLineHeld({ hold, rules, ranking, now: at, told: live.told?.since ?? null }).action !==
              'tellNeo'
          )
            return [];
          const text = pending ?? lineHeldText(todo, hold, ranking);
          if (pending === null)
            deps.database().run(
              `INSERT INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, '${PACK}', 'told', ?)
               ON CONFLICT(todo_id, pack, key) DO UPDATE SET value_json = excluded.value_json`,
              todo.id,
              JSON.stringify({ since: hold.since, text })
            );
          return [
            {
              kind: LINE_HELD,
              subject: { type: 'todo', id: todo.id },
              since: hold.since,
              facts: { text },
            },
          ];
        });
      },
      ['ranked', 'rules', 'now'],
      'events'
    )
    .endAsync('events') as (now: number) => Promise<NeoAttentionEvent[]>;

  const sent = (event: NeoAttentionEvent) =>
    deps.database().run(
      `UPDATE pack_facts SET value_json = json_set(value_json, '$.sent', json('true'))
       WHERE todo_id = ? AND pack = '${PACK}' AND key = 'told'
         AND json_extract(value_json, '$.since') = ?`,
      event.subject.id,
      event.since
    );

  return {
    ...MODEL_ROUTING_PACK_BRIEF,
    preferences,
    rankLines: rank,
    attention: {
      kinds: [
        {
          id: LINE_HELD,
          decide: () => 'wake',
          render: ({ facts }) => String(facts.text),
          sent,
        },
      ],
      scan,
    },
    instructions: () => null,
  };
}
