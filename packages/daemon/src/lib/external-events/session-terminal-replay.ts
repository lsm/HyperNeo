import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionEventSubscription } from '../../storage/repositories/session-event-subscription-repository.ts';
import { parseGitHubTopic } from '../github/parse-pr-url.ts';
import { requireClosedPrEvent } from './session-subscription-close.ts';
import type { ExternalEvent, ExternalEventRecord } from './types.ts';

interface ReplayDeps {
  listSubscriptions(): SessionEventSubscription[];
  readLatestPrState(subject: string): Promise<ExternalEventRecord | null>;
  publish(event: ExternalEvent): Promise<unknown>;
}

export const replaySessionTerminals = (superpipe({})('replay-session-terminals') as PipelineAPI)
  .input('deps')
  .pipe(
    (deps: ReplayDeps) => [
      ...new Set(
        deps.listSubscriptions().flatMap((sub) => {
          const pr = parseGitHubTopic(sub.topic);
          return pr?.resource === 'pull_request' &&
            /^[1-9]\d*$/.test(pr.entity) &&
            /^[\w.-]+$/.test(pr.owner) &&
            /^[\w.-]+$/.test(pr.repo)
            ? [`github/${pr.owner}/${pr.repo}/pull_request/${pr.entity}`.toLowerCase()]
            : [];
        })
      ),
    ],
    'deps',
    'subjects'
  )
  .pipe(
    async (deps: ReplayDeps, subjects: string[]) =>
      Promise.all(subjects.map((subject) => deps.readLatestPrState(subject))),
    ['deps', 'subjects'],
    'records'
  )
  .pipe(
    async (deps: ReplayDeps, records: (ExternalEventRecord | null)[]) => {
      const terminal = records.filter(
        (record): record is ExternalEventRecord =>
          record !== null && 'value' in requireClosedPrEvent({ record })
      );
      await Promise.all(terminal.map((record) => deps.publish(record.event)));
      return terminal.length;
    },
    ['deps', 'records'],
    'count'
  )
  .endAsync('count') as (deps: ReplayDeps) => Promise<number>;
