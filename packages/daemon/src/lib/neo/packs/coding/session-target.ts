import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoTodoTarget } from '../../driver-work.ts';
import type { NeoWorkerTargetDecision } from '../../pack-contract.ts';
import { codingStageTargetReads } from './stage-target-db.ts';
import {
  type CodingLines,
  codingCandidateLine,
  codingStartAlternatives,
  rankCodingTargets,
  lineText,
  rankedHere,
} from './stage-lines.ts';

const workKind = (todo: NeoTodo) =>
  typeof todo.named?.workKind === 'string' ? todo.named.workKind : 'coding.write';

export const decideCodingSessionTarget = (superpipe({})('coding.session-target') as PipelineAPI)
  .input(['db', 'todo', 'target', 'lines'])
  .pipe(
    async (db: Database, todo: NeoTodo, target: NeoTodoTarget, lines: CodingLines | undefined) => {
      if (target.verb !== 'start') return { value: target };
      const repo = await gatewayFor(db).call(codingStageTargetReads, 'repo', todo.id);
      const saved =
        repo && rankedHere(target)
          ? await gatewayFor(db).call(codingStageTargetReads, 'stagePreference', {
              repo,
              stage: 'write',
            })
          : {};
      const usable = async (field: 'model' | 'effort') => {
        const value = !target[field] && saved[field];
        if (!value || !lines) return {};
        const resolved = await lines.resolve({ adapter: target.adapter, [field]: value });
        return resolved?.ok ? { [field]: value } : {};
      };
      const start = { ...target, ...(await usable('model')), ...(await usable('effort')) };
      if (!lines) return { value: start };
      const scope = await gatewayFor(db).call(codingStageTargetReads, 'lineScope', {
        todoId: todo.id,
        ...(repo ? { repo } : {}),
      });
      const ranked = await rankCodingTargets(
        lines,
        workKind(todo),
        await codingStartAlternatives(start, lines),
        scope
      );
      if ('reason' in ranked) return { reason: ranked.reason };
      const [chosen] = ranked.value;
      if (ranked.sources[0] === start) return { value: chosen };
      const [from, to] = await Promise.all(
        [start, chosen].map(async (entry) =>
          lineText((await codingCandidateLine(lines, entry)).line)
        )
      );
      const why = ranked.skipped.find((text) => text.startsWith(`${from}: `));
      return {
        value: chosen,
        note: `Started on ${to} instead of ${why ?? `${from}: the route ranks it lower`}.`,
      };
    },
    ['db', 'todo', 'target', 'lines'],
    'decision'
  )
  .endAsync('decision') as (
  db: Database,
  todo: NeoTodo,
  target: NeoTodoTarget,
  lines?: CodingLines
) => Promise<NeoWorkerTargetDecision>;
