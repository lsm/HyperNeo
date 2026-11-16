import { THINKING_LEVEL_EFFORT, THINKING_OPTIONS } from '@hyperneo/shared';
import type { ModelInfo } from '@hyperneo/shared';
import type { WorkAdapter } from '../../../drivers/types.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { usableModels } from '../../../usable-models.ts';
import type { NeoLine, NeoLineRanking, NeoLineScope, NeoWorkKind } from '../../pack-contract.ts';

type Candidate = {
  adapter: string;
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
  defaultEffort: () => string | undefined;
  models: () => readonly ModelInfo[];
};

export const CODING_WORK_KINDS: readonly NeoWorkKind[] = [
  { id: 'coding.write', label: { en: 'Coding: write', 'zh-Hans': '编码：编写' } },
  { id: 'coding.review', label: { en: 'Coding: review', 'zh-Hans': '编码：审查' } },
  { id: 'coding.verify', label: { en: 'Coding: verify', 'zh-Hans': '编码：验证' } },
];

export async function codingCandidateLine<T extends Candidate>(
  lines: CodingLines,
  target: T
): Promise<{ line: NeoLine; target: T }> {
  const resolved = await lines.resolve(target).catch(() => null);
  const value = resolved?.ok ? resolved.value : null;
  const effort = (value ? value.effort : target.effort) ?? lines.defaultEffort();
  const model = value?.model ?? target.model;
  return {
    line: {
      provider: value?.provider ?? '',
      model: model ?? '',
      harness: target.adapter,
      ...(effort ? { effort } : {}),
    },
    target: value
      ? { ...target, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
      : target,
  };
}

const rankedHere = (target: Candidate) => target.adapter === 'hyperneo' && !target.place?.daemon;

export function codingStartAlternatives<T extends Candidate>(
  target: T,
  models: readonly ModelInfo[]
): T[] {
  if (!rankedHere(target)) return [target];
  const ids = [...new Set(usableModels(models).map((model) => model.id))];
  return [
    target,
    ...ids.filter((id) => id !== target.model).map((model) => ({ ...target, model })),
  ];
}

async function effortOffers<T extends Candidate>(lines: CodingLines, source: T) {
  const base = await codingCandidateLine(lines, source);
  const known = lines
    .models()
    .find((model) => model.id === base.line.model && model.provider === base.line.provider);
  const at = THINKING_OPTIONS.findIndex(({ label }) => label.toLowerCase() === base.line.effort);
  const levels = THINKING_OPTIONS.flatMap(({ value, label }, index) => {
    const id = THINKING_LEVEL_EFFORT[value];
    return id && (!known?.effortLevels || known.effortLevels.includes(id)) && index !== at
      ? [{ effort: label.toLowerCase(), distance: at === -1 ? index : Math.abs(index - at) }]
      : [];
  })
    .sort((a, b) => a.distance - b.distance)
    .map(({ effort }) => effort);
  const variants = await Promise.all(
    levels.map((effort) => codingCandidateLine(lines, { ...base.target, effort }))
  );
  return [
    base,
    ...variants.filter(
      (offer) =>
        offer.line.provider === base.line.provider && offer.line.effort !== base.line.effort
    ),
  ].map((offer) => ({ ...offer, source }));
}

const lineText = (line: NeoLine) =>
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
  const offers = (await Promise.all(routed.map((source) => effortOffers(lines, source)))).flat();
  const candidates = offers.map((offer) => offer.line);
  const ranking = await lines.rank(kind, candidates, scope);
  const skipped = [
    ...new Set(ranking.skipped.map(({ line, reason }) => `${lineText(line)}: ${reason}`)),
  ];
  const ranked = ranking.ranked
    .flatMap(({ line }) => offers.filter((offer) => offer.line === line))
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
