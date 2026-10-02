import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { SessionInputDraftSnapshot } from '../../storage/repositories/session-input-draft-write.ts';
import type { SessionCache } from './session-cache.ts';

export type SessionInputDraftCommitOutcome =
  | { kind: 'won'; notified: boolean }
  | { kind: 'superseded' | 'invalid' };

type DraftDatabase = Pick<Database, 'casSessionInputDraft'>;
type DraftCache = Pick<SessionCache, 'has' | 'get'>;
type DraftPublisher = (sessionId: string, text: string | null) => Promise<void>;
type CommittedDraft = { sessionId: string; text: string | null };

function commitInputDraftStage(
  snapshot: SessionInputDraftSnapshot,
  text: string | null,
  db: DraftDatabase,
  cache: DraftCache
): { value: CommittedDraft } | { reason: SessionInputDraftCommitOutcome } {
  const outcome = db.casSessionInputDraft(snapshot, text);
  if (outcome !== 'won') return { reason: { kind: outcome } };
  const agent = cache.has(snapshot.id) ? cache.get(snapshot.id) : null;
  agent?.applyCommittedInputDraft(text);
  return { value: { sessionId: snapshot.id, text } };
}

async function publishInputDraftStage(
  committed: CommittedDraft,
  publish: DraftPublisher
): Promise<SessionInputDraftCommitOutcome> {
  try {
    await publish(committed.sessionId, committed.text);
    return { kind: 'won', notified: true };
  } catch {
    return { kind: 'won', notified: false };
  }
}

export const commitSessionInputDraft = (superpipe({})('session-input-draft-commit') as PipelineAPI)
  .input(['snapshot', 'text', 'db', 'cache', 'publish'])
  .pipe(commitInputDraftStage, ['snapshot', 'text', 'db', 'cache'], 'result:outcome')
  .pipe(publishInputDraftStage, ['outcome', 'publish'], 'outcome')
  .endAsync('outcome') as (
  snapshot: SessionInputDraftSnapshot,
  text: string | null,
  db: DraftDatabase,
  cache: DraftCache,
  publish: DraftPublisher
) => Promise<SessionInputDraftCommitOutcome>;
