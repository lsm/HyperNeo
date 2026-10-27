import type { Session } from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { MessageDeliveryTerminalTurnError, withSessionLock } from './message-delivery.ts';
import { sleep } from '../utils/sleep.ts';

type Episode = NonNullable<Session['metadata']['queryFailureEpisode']>;
export class QueryFailureCapError extends MessageDeliveryTerminalTurnError {}
const empty = (id: string = crypto.randomUUID()): Episode => ({
  id,
  failures: 0,
  retryAt: 0,
  error: '',
  failed: false,
});
const aborted = () =>
  Object.assign(new Error('Query failure episode superseded'), { name: 'AbortError' });
const advance = (superpipe({})('query-failure-episode') as PipelineAPI)
  .input(['prior', 'error', 'now'])
  .pipe((prior: Episode) => prior.failures + 1, 'prior', 'failures')
  .pipe((failures: number) => failures >= 3, 'failures', 'failed')
  .pipe(
    (prior: Episode, error: string, now: number, failures: number, failed: boolean): Episode => ({
      ...prior,
      error,
      failures,
      failed,
      retryAt: now + 1000 * 2 ** (failures - 1),
    }),
    ['prior', 'error', 'now', 'failures', 'failed'],
    'episode'
  )
  .end('episode') as (prior: Episode, error: string, now: number) => Episode;

export class QueryFailureGovernor {
  constructor(
    private session: Session,
    private db: Database
  ) {}

  private read() {
    const stored = this.db.getSession(this.session.id);
    return stored?.metadata.queryFailureEpisode ?? this.session.metadata.queryFailureEpisode;
  }

  private change(transform: (prior: Episode) => Episode, expected?: string) {
    return withSessionLock(this.session.id, async () => {
      const saved = this.read(),
        prior = saved ?? empty();
      if (expected && expected !== prior.id) throw aborted();
      const next = transform(prior);
      if (!saved || next !== prior)
        await this.db.updateSession(this.session.id, {
          metadata: { queryFailureEpisode: next } as Session['metadata'],
        });
      this.session.metadata.queryFailureEpisode = next;
      return next;
    });
  }

  assertOpen() {
    const episode = this.read();
    if (episode?.failed)
      throw new QueryFailureCapError(
        `Query stopped after ${episode.failures} failures: ${episode.error}. Use Retry to recover.`
      );
  }

  async admit(live: () => boolean) {
    this.assertOpen();
    const episode = await this.change((prior) => prior);
    const delay = episode.retryAt - Date.now();
    if (delay > 0) await sleep(delay);
    if (!live() || this.read()?.id !== episode.id) throw aborted();
    this.assertOpen();
    return episode.id;
  }

  failure(error: string, id: string) {
    return this.change((prior) => advance(prior, error, Date.now()), id);
  }
  success(id: string) {
    return this.change(() => empty(id), id);
  }
  reset() {
    return this.change(() => empty());
  }

  async prepare<T>(run: () => Promise<T>, deadline: number, live: () => boolean): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Query preparation timed out')),
            Math.max(0, deadline - Date.now())
          );
        }),
      ]);
      if (!live()) throw aborted();
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}
