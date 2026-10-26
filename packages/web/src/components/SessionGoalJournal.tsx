import type { SessionGoal, GoalJournalEntry } from '@hyperneo/shared/types/session-goal';
import type { OperationName } from '@hyperneo/shared/types/operation-names';
import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation, requireAccepted, type OperationRejection } from '../lib/operations.ts';
import { t, locale } from '../lib/i18n/index.ts';
import { NativeContentDisclosure } from './ui/NativeContentDisclosure.tsx';
import { Button } from './ui/Button.tsx';
async function read<T>(name: OperationName, input: unknown): Promise<T> {
  return requireAccepted(
    await invokeOperation<T | OperationRejection>(await connectionManager.getHub(), name, input)
  );
}
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : t('goalDetails.failed');
function webLink(ref: string) {
  try {
    return ['https:', 'http:'].includes(new URL(ref).protocol) ? ref : undefined;
  } catch {
    return undefined;
  }
}
export function goalMandateLink(remote: string, goal: SessionGoal) {
  if (!webLink(remote) || !goal.mandateRef) return undefined;
  const url = new URL(remote);
  if (url.hostname !== 'github.com' && url.hostname !== 'gitlab.com') return remote;
  const [path, hash] = goal.mandateRef.split('#');
  return `${remote}${url.hostname === 'gitlab.com' ? '/-' : ''}/blob/${encodeURIComponent(goal.mandateRev ?? 'HEAD')}/${path.split('/').map(encodeURIComponent).join('/')}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
}
function JournalEntryBody({ entry }: { entry: GoalJournalEntry }) {
  return (
    <div class="space-y-1 py-2">
      <p>{entry.done}</p>
      <p>
        {t('goalDetails.worked')}: {entry.worked}
      </p>
      {entry.failed && (
        <p>
          {t('goalDetails.failedApproach')}: {entry.failed}
        </p>
      )}
      <ul>
        {entry.evidence.map((item, index) => (
          <li key={index}>
            {webLink(item.ref) ? (
              <a
                href={webLink(item.ref)}
                target="_blank"
                rel="noopener noreferrer"
                class="text-accent hover:underline"
              >
                {item.note ?? item.ref}
              </a>
            ) : (
              <span>{item.note ?? item.ref}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
function JournalEntry({ entry, explicit }: { entry: GoalJournalEntry; explicit?: boolean }) {
  const created = (
    <time class="ml-2 text-fg-muted" dateTime={new Date(entry.createdAt).toISOString()}>
      {new Date(entry.createdAt).toLocaleDateString(locale.value)}
    </time>
  );
  return explicit ? (
    <NativeContentDisclosure
      data-journal-entry={entry.id}
      class="border-t border-line pt-2"
      label={entry.effect}
      summary={
        <span class="break-words">
          {entry.effect}
          {created}
        </span>
      }
    >
      <JournalEntryBody entry={entry} />
    </NativeContentDisclosure>
  ) : (
    <details data-journal-entry={entry.id} class="border-t border-line pt-2">
      <summary class="cursor-pointer break-words">
        {entry.effect}
        {created}
      </summary>
      <JournalEntryBody entry={entry} />
    </details>
  );
}
export function GoalJournal({
  ownerSessionId,
  goalId,
  explicit,
}: {
  ownerSessionId: string;
  goalId: string;
  explicit?: boolean;
}) {
  const [request, setRequest] = useState<{ before?: string }>({});
  const [entries, setEntries] = useState<GoalJournalEntry[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void read<{ entries: GoalJournalEntry[] }>('goal.journal.list', {
      ownerSessionId,
      goalId,
      ...request,
      limit: 20,
    })
      .then((result) => {
        if (alive) {
          setEntries((previous) =>
            request.before ? [...previous, ...result.entries] : result.entries
          );
          setMore(result.entries.length === 20);
        }
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ownerSessionId, goalId, request]);
  return (
    <section aria-label={t('goalDetails.journal')} class="space-y-2">
      <h4 class="font-medium">{t('goalDetails.journal')}</h4>
      {entries.map((entry) => (
        <JournalEntry key={entry.id} entry={entry} explicit={explicit} />
      ))}
      {loading && <p role="status">{t('goalDetails.loading')}</p>}
      {error && (
        <p role="alert" class="text-danger">
          {error}
        </p>
      )}
      {!loading && !error && !entries.length && <p>{t('schedules.emptyJournal')}</p>}
      {more && (entries.length > 0 || !!error) && (
        <Button
          variant="ghost"
          size="xs"
          disabled={loading}
          onClick={() =>
            setRequest(entries.length ? { before: entries[entries.length - 1].id } : {})
          }
        >
          {entries.length ? t('goalDetails.older') : t('goalDetails.retry')}
        </Button>
      )}
    </section>
  );
}
