import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoTodoCheckResult } from '../../pack-contract.ts';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';
import { codingStagePasses, type CodingStageFact } from './stage-facts.ts';
import type { CodingDeliverySnapshot } from './delivery-facts.ts';

export const gateCodingCompletion = (superpipe({})('coding.delivery-completion') as PipelineAPI)
  .input(['legacy', 'prs', 'snapshot'])
  .pipe(
    (legacy: NeoTodoCheckResult | null, snapshot: CodingDeliverySnapshot) =>
      !snapshot.required || !legacy?.done ? { reason: legacy } : { value: true },
    ['legacy', 'snapshot'],
    'result:result'
  )
  .pipe(
    (prs: readonly NeoWorkPr[], snapshot: CodingDeliverySnapshot): NeoTodoCheckResult => {
      const delivered =
        prs.length > 0 &&
        prs.every(
          (pr) =>
            pr.state === 'MERGED' &&
            pr.head &&
            snapshot.deliveries.some(({ gate, smoke, stages }) => {
              const covered = (fact: CodingStageFact, ref: typeof gate.qa) =>
                codingStagePasses(fact, gate.url, gate.head, gate.acceptanceContract, ref) &&
                fact.evidence.every((link) => gate.evidence.includes(link));
              return (
                gate.head === pr.head &&
                githubUrlKey(gate.url) === githubUrlKey(pr.url) &&
                smoke &&
                stages.some((fact) => fact.stage === 'qa' && covered(fact, gate.qa)) &&
                (typeof gate.reviewer === 'string' ||
                  stages.some(
                    (fact) =>
                      fact.stage === 'review' &&
                      typeof gate.reviewer !== 'string' &&
                      covered(fact, gate.reviewer)
                  )) &&
                ((smoke.verdict === 'pass' && smoke.build) ||
                  (smoke.verdict === 'inapplicable' && smoke.reason))
              );
            })
        );
      return delivered
        ? {
            done: true,
            evidence: snapshot.deliveries
              .flatMap(({ gate, smoke }) =>
                smoke
                  ? [
                      `${gate.url}: ${
                        smoke.verdict === 'inapplicable'
                          ? `smoke inapplicable (${smoke.reason})`
                          : `QA smoke ${smoke.verdict} on ${smoke.build?.daemon}@${smoke.build?.commit}`
                      }; ${smoke.evidence.join(' ')}`,
                    ]
                  : []
              )
              .join('\n'),
          }
        : { done: false, evidence: null };
    },
    ['prs', 'snapshot'],
    'result'
  )
  .end('result') as (
  legacy: NeoTodoCheckResult | null,
  prs: readonly NeoWorkPr[],
  snapshot: CodingDeliverySnapshot
) => NeoTodoCheckResult | null;
