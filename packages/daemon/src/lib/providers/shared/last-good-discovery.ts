import type { CuratedModel } from '@hyperneo/shared/provider';

export interface LastGoodDiscoveredList {
  models: CuratedModel[];
  truncated?: boolean;
}

export function buildLastGoodDiscoveredModels(
  curated: ReadonlyArray<CuratedModel> | undefined,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
  budget: number
): LastGoodDiscoveredList {
  const byId = new Map<string, CuratedModel>();
  for (const entry of curated ?? []) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, {
        id: entry.id,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      });
    }
  }
  const curatedCount = byId.size;
  for (const model of discovered) {
    const seeded = byId.get(model.id);
    if (seeded) {
      if (seeded.name === undefined && model.name !== undefined) seeded.name = model.name;
      continue;
    }
    byId.set(model.id, {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
    });
  }
  const models: CuratedModel[] = [];
  let used = 2;
  let index = 0;
  let truncated = false;
  for (const entry of byId.values()) {
    let candidate = entry;
    let cost = JSON.stringify(entry).length + (models.length === 0 ? 0 : 1);
    if (used + cost > budget && entry.name !== undefined) {
      const bare: CuratedModel = { id: entry.id };
      const bareCost = JSON.stringify(bare).length + (models.length === 0 ? 0 : 1);
      if (used + bareCost <= budget) {
        candidate = bare;
        cost = bareCost;
      }
    }
    if (used + cost > budget) {
      if (index < curatedCount) {
        throw new Error('Provider config has no capacity to retain all curated models');
      }
      truncated = true;
      break;
    }
    models.push(candidate);
    used += cost;
    index++;
  }
  return { models, ...(truncated ? { truncated: true } : {}) };
}
