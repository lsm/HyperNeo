import type { ModelInfo } from '@hyperneo/shared';
import type { WorkAdapter } from '../../../drivers/types.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { usableModels } from '../../../usable-models.ts';
import type { NeoLine, NeoLineRanking, NeoLineScope, NeoWorkKind } from '../../pack-contract.ts';

type Candidate = { adapter: string; model?: string; effort?: string };
type Resolved = Awaited<ReturnType<NonNullable<WorkAdapter['resolveStartConfiguration']>>>;
export type CodingLines = {
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

export async function codingCandidateLine(lines: CodingLines, target: Candidate): Promise<NeoLine> {
  const resolved = await lines.resolve(target).catch(() => null);
  const value = resolved?.ok ? resolved.value : null;
  const effort = value ? value.effort : target.effort;
  return {
    provider: value?.provider ?? '',
    model: value?.model ?? target.model ?? '',
    harness: target.adapter,
    ...(effort ? { effort } : {}),
  };
}

export function codingStartAlternatives<T extends Candidate>(
  target: T,
  models: readonly ModelInfo[]
): T[] {
  if (target.adapter !== 'hyperneo') return [target];
  return [
    target,
    ...usableModels(models)
      .filter((model) => model.id !== target.model)
      .map((model) => ({ ...target, model: model.id })),
  ];
}

const lineText = (line: NeoLine) =>
  `${[line.provider, line.model].filter(Boolean).join('/')} via ${line.harness}`;

export async function rankCodingTargets<T extends Candidate>(
  lines: CodingLines,
  kind: string,
  targets: readonly T[],
  scope: NeoLineScope
): Promise<{ value: T[]; skipped: string[] } | { reason: string }> {
  const routed = targets.filter((target) => target.adapter === 'hyperneo');
  if (!routed.length) return { value: [...targets], skipped: [] };
  const candidates = await Promise.all(routed.map((target) => codingCandidateLine(lines, target)));
  const ranking = await lines.rank(kind, candidates, scope);
  const skipped = ranking.skipped.map(({ line, reason }) => `${lineText(line)}: ${reason}`);
  const ranked = ranking.ranked.flatMap(({ line }) => {
    const index = candidates.indexOf(line);
    return index === -1 ? [] : [routed[index]];
  });
  let slot = 0;
  const value = targets.flatMap((target) =>
    target.adapter !== 'hyperneo' ? [target] : slot < ranked.length ? [ranked[slot++]] : []
  );
  return value.length
    ? { value, skipped }
    : { reason: `No usable model line for ${kind}: ${skipped.join('; ')}.` };
}

export function codingLineScope(db: Database, todoId: string, repo?: string): NeoLineScope {
  const asks = new NeoAskTodoRepository(db);
  const todo = asks.getTodo(todoId);
  const projectId = todo ? asks.getAsk(todo.askId)?.projectId : null;
  return { ...(repo ? { repo } : {}), ...(projectId ? { projectId } : {}) };
}
