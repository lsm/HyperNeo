import type { ModelInfo } from '@hyperneo/shared';
import type { WorkAdapter } from '../../../drivers/types.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { usableModels } from '../../../usable-models.ts';
import type { NeoLine, NeoLineRanking, NeoLineScope, NeoWorkKind } from '../../pack-contract.ts';

type Candidate = {
  adapter: string;
  provider?: string;
  model?: string;
  effort?: string;
  place?: { machine: string; daemon?: string };
};
type Resolved = Awaited<ReturnType<NonNullable<WorkAdapter['resolveStartConfiguration']>>>;
export type CodingLines = {
  active: () => boolean;
  rank: (
    kind: string,
    candidates: readonly NeoLine[],
    scope: NeoLineScope
  ) => Promise<NeoLineRanking>;
  resolve: (target: Candidate) => Promise<Resolved>;
  models: () => readonly ModelInfo[];
};

export const CODING_WORK_KINDS: readonly NeoWorkKind[] = [
  { id: 'coding.write', label: { en: 'Coding: write', 'zh-Hans': '编码：编写' } },
  { id: 'coding.review', label: { en: 'Coding: review', 'zh-Hans': '编码：审查' } },
  { id: 'coding.verify', label: { en: 'Coding: verify', 'zh-Hans': '编码：验证' } },
];

async function pinnedModel(lines: CodingLines, adapter: string, provider: string, id: string) {
  const entry = lines.models().find((model) => model.id === id && model.provider === provider);
  const selectors = [id, entry?.name, entry?.alias, ...(entry?.providerAliases ?? [])];
  for (const model of [...new Set(selectors.filter(Boolean))] as string[]) {
    const again = await lines.resolve({ adapter, model }).catch(() => null);
    if (again?.ok && again.value.provider === provider && again.value.model === id) return model;
  }
  return null;
}

export async function codingCandidateLine<T extends Candidate>(
  lines: CodingLines,
  target: T
): Promise<{ line: NeoLine; target: T }> {
  const resolved = await lines.resolve(target).catch(() => null);
  const value = resolved?.ok ? resolved.value : null;
  const model = value?.model ?? target.model;
  const pinned =
    target.model ??
    (value?.model
      ? await pinnedModel(lines, target.adapter, value.provider ?? '', value.model)
      : undefined);
  return {
    line: {
      provider: (pinned && value?.provider) || '',
      model: model ?? '',
      harness: target.adapter,
    },
    target: pinned ? { ...target, model: pinned } : target,
  };
}

export const rankedHere = (target: Candidate) =>
  target.adapter === 'hyperneo' && !target.place?.daemon;

export async function codingStartAlternatives<T extends Candidate>(
  target: T,
  lines: CodingLines
): Promise<T[]> {
  if (!rankedHere(target)) return [target];
  const selectors = await Promise.all(
    usableModels(lines.models()).map((model) =>
      pinnedModel(lines, target.adapter, model.provider, model.id)
    )
  );
  return [
    target,
    ...[...new Set(selectors)]
      .filter((model): model is string => !!model && model !== target.model)
      .map((model) => ({ ...target, model })),
  ];
}

const sameLine = (a: NeoLine, b: NeoLine) =>
  a.provider === b.provider && a.model === b.model && a.harness === b.harness;

export const lineText = (line: NeoLine) =>
  `${[line.provider, line.model].filter(Boolean).join('/')} via ${line.harness}`;

export async function rankCodingTargets<T extends Candidate>(
  lines: CodingLines,
  kind: string,
  targets: readonly T[],
  scope: NeoLineScope
): Promise<{ value: T[]; sources: T[]; skipped: string[] } | { reason: string }> {
  const routed = targets.filter(rankedHere);
  if (!routed.length || !lines.active())
    return { value: [...targets], sources: [...targets], skipped: [] };
  const offers = await Promise.all(
    routed.map(async (source) => ({ ...(await codingCandidateLine(lines, source)), source }))
  );
  const candidates = offers.map((offer) => offer.line);
  const ranking = await lines.rank(kind, candidates, scope);
  const skipped = [
    ...new Set(ranking.skipped.map(({ line, reason }) => `${lineText(line)}: ${reason}`)),
  ];
  const ranked = ranking.ranked
    .flatMap(({ line }) => offers.filter((offer) => sameLine(offer.line, line)))
    .filter(
      (offer, index, all) => all.findIndex((other) => other.source === offer.source) === index
    )
    .map((offer) => ({ value: offer.target, source: offer.source }));
  let slot = 0;
  const order = targets.flatMap((target) =>
    !rankedHere(target)
      ? [{ value: target, source: target }]
      : slot < ranked.length
        ? [ranked[slot++]]
        : []
  );
  return order.length
    ? {
        value: order.map((entry) => entry.value),
        sources: order.map((entry) => entry.source),
        skipped,
      }
    : { reason: `No usable model line for ${kind}: ${skipped.join('; ')}.` };
}

export function codingLineScope(db: Database, todoId: string, repo?: string): NeoLineScope {
  const asks = new NeoAskTodoRepository(db);
  const todo = asks.getTodo(todoId);
  const projectId = todo ? asks.getAsk(todo.askId)?.projectId : null;
  return { ...(repo ? { repo } : {}), ...(projectId ? { projectId } : {}) };
}
