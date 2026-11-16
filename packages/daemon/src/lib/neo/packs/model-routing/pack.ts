import superpipe, { type PipelineAPI } from 'superpipe';
import type { Provider } from '@hyperneo/shared/provider';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { readProviderUsage } from '../../../rpc-handlers/family-operations/settings.ts';
import type {
  NeoLine,
  NeoLineRanking,
  NeoLineScope,
  NeoPack,
  NeoPackBrief,
  NeoPackPreferenceDeclaration,
} from '../../pack-contract.ts';
import { getNeoPackPreference } from '../../preferences.ts';
import {
  type Availability,
  type LineHold,
  type LineRule,
  type RankInput,
  type Route,
  rankLines,
  type UsageReading,
} from './rank.ts';

const PACK = 'model-routing';

const listPreference = (
  kind: 'routes' | 'lineRules',
  en: string,
  zh: string
): NeoPackPreferenceDeclaration => ({
  label: { en, 'zh-Hans': zh },
  valueLabels: {},
  scope: 'global',
  type: { kind },
  default: [],
  ask: en,
});

const preferences = {
  routes: listPreference(
    'routes',
    'Which lines does each kind of work prefer?',
    '各类工作优先用哪些模型线路？'
  ),
  rules: listPreference('lineRules', 'Where may each line be used?', '每条线路可以用在哪里？'),
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

function readPrefs(db: Database): RankInput['prefs'] {
  const read = (key: keyof typeof preferences) =>
    getNeoPackPreference(db, PACK, { kind: 'global', key: '' }, key)?.value ?? [];
  return { routes: read('routes') as Route[], rules: read('rules') as LineRule[] };
}

function readHolds(db: Database): LineHold[] {
  return db
    .prepare(`SELECT json_extract(config, '$.provider') AS provider,
        json_extract(config, '$.model') AS model,
        json_extract(processing_state, '$.reason') AS reason,
        json_extract(processing_state, '$.retryAt') AS retryAt
      FROM sessions
      WHERE json_valid(processing_state) AND json_valid(config)
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
  if (!provider || !(await provider.isAvailable())) return 'not configured';
  const status = await provider.getAuthStatus?.();
  return status && !status.isAuthenticated ? 'not signed in' : 'ready';
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

  return {
    ...MODEL_ROUTING_PACK_BRIEF,
    preferences,
    rankLines: rank,
    instructions: () => null,
  };
}
