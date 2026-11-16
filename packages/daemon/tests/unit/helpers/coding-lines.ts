import type { ModelInfo } from '@hyperneo/shared';
import {
  createHyperneoAdapter,
  type HyperneoAdapterDeps,
} from '../../../src/lib/drivers/hyperneo-adapter.ts';
import type { LineHold, LineRule, Route } from '../../../src/lib/neo/packs/model-routing/rank.ts';
import { rankLines } from '../../../src/lib/neo/packs/model-routing/rank.ts';
import type { CodingLines } from '../../../src/lib/neo/packs/coding/stage-lines.ts';
import { resolveDriverModel } from '../../../src/lib/rpc-handlers/family-operations/drivers.ts';

export const catalogModel = (
  id: string,
  provider: string,
  name = id,
  available = true
): ModelInfo => ({
  id,
  name,
  alias: `${id}-alias`,
  family: 'opus',
  provider,
  contextWindow: 200_000,
  description: id,
  releaseDate: '2026-01-01',
  available,
});

export function driverCodingLines(
  catalog: readonly ModelInfo[],
  prefs: { routes?: Route[]; rules?: LineRule[]; holds?: LineHold[]; ready?: string[] } = {},
  calls: string[] = []
): CodingLines {
  const adapter = createHyperneoAdapter({
    sessions: {
      resolveModel: (model: string) => resolveDriverModel(catalog, model),
      resolveDefaultModel: async () => ({ id: catalog[0].id, provider: catalog[0].provider }),
    },
  } as unknown as HyperneoAdapterDeps);
  return {
    models: () => catalog,
    resolve: async (target) =>
      target.adapter === 'hyperneo'
        ? ((await adapter.resolveStartConfiguration?.({
            place: { machine: 'fixture', name: 'Fixture' },
            title: '',
            message: '',
            ...target,
          })) ?? null)
        : null,
    rank: async (kind, candidates, scope) => {
      calls.push(`${kind} ${scope.repo ?? ''} ${scope.projectId ?? ''}`.trim());
      return rankLines({
        kind,
        candidates,
        scope,
        prefs: { routes: prefs.routes ?? [], rules: prefs.rules ?? [] },
        holds: prefs.holds ?? [],
        usage: {},
        availability: Object.fromEntries(
          (prefs.ready ?? [...new Set(catalog.map((model) => model.provider))]).map((id) => [
            id,
            'ready' as const,
          ])
        ),
        now: 1_000,
      });
    },
  };
}
