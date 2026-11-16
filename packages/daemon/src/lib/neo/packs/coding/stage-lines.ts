import type { ModelInfo } from '@hyperneo/shared';
import { findInModels } from '../../../model-service.ts';
import { usableModels } from '../../../usable-models.ts';
import type { NeoLine, NeoLineRanking, NeoLineScope, NeoWorkKind } from '../../pack-contract.ts';

export type CodingLines = {
  rank: (
    kind: string,
    candidates: readonly NeoLine[],
    scope: NeoLineScope
  ) => Promise<NeoLineRanking>;
  models: () => readonly ModelInfo[];
};
type Candidate = { adapter: string; model?: string; effort?: string };

export const CODING_WORK_KINDS: readonly NeoWorkKind[] = [
  { id: 'coding.write', label: { en: 'Coding: write', 'zh-Hans': '编码：编写' } },
  { id: 'coding.review', label: { en: 'Coding: review', 'zh-Hans': '编码：审查' } },
  { id: 'coding.verify', label: { en: 'Coding: verify', 'zh-Hans': '编码：验证' } },
];

export function codingCandidateLine(target: Candidate, models: readonly ModelInfo[]): NeoLine {
  return {
    provider: (target.model && findInModels(usableModels(models), target.model)?.provider) ?? '',
    model: target.model ?? '',
    harness: target.adapter,
    ...(target.effort ? { effort: target.effort } : {}),
  };
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
  const models = lines.models();
  const candidates = routed.map((target) => codingCandidateLine(target, models));
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
