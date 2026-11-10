import { SessionExternalEventStore } from '../../../src/lib/external-events/session-external-event-store.ts';
import type { Database } from '../../../src/storage/sqlite-compat.ts';
import { runMigration331 } from '../../../src/storage/schema/m331-session-external-events.ts';

export const subject = 'github/synthetic/widgets/pull_request/7';
export const topicIndex = 'idx_session_external_events_source_topic_lower';
export const legacySql = `SELECT * FROM session_external_events
  WHERE source = 'github' AND lower(substr(topic, 1, ?)) = ?
  AND (json_extract(payload_json, '$.eventType') = 'pull_request' OR lower(topic) IN (?, ?, ?, ?))
  AND (json_extract(payload_json, '$.state') IN ('open', 'closed') OR lower(topic) IN (?, ?, ?))
  ORDER BY occurred_at DESC, ingested_at DESC, rowid DESC LIMIT 1`;

export function legacyBindings(value: string): (string | number)[] {
  const prefix = `${value.toLowerCase()}.`;
  const topics = ['closed', 'opened', 'reopened'].map((action) => `${prefix}${action}`);
  return [prefix.length, prefix, ...topics, `${prefix}polled`, ...topics];
}

export function seedPrHistory(db: Database): void {
  runMigration331(db);
  const insert = db.prepare(`INSERT INTO session_external_events
    (id, source, topic, dedupe_key, occurred_at, ingested_at, summary, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Synthetic event', ?, 1)`);
  let sequence = 0;
  const add = (
    id: string,
    topic: string,
    occurred: number,
    payload: Record<string, unknown>,
    source = 'github',
    ingested = occurred
  ) =>
    insert.run(
      id,
      source,
      topic,
      `synthetic-${sequence++}`,
      occurred,
      ingested,
      JSON.stringify(payload)
    );
  db.transaction(() => {
    const payload = { eventType: 'pull_request', state: 'closed', body: 'synthetic '.repeat(200) };
    for (let i = 0; i < 26_592; i++)
      add(
        `background-${i}`,
        `github/synthetic/widgets/pull_request/${i + 100}.closed`,
        100,
        payload
      );
    add('closed', `${subject.toUpperCase()}.CLOSED`, 10, {});
    add('poll', `${subject}.polled`, 20, { state: 'closed' });
    add('sync', `${subject}.SyNcHrOnIzE`, 30, { eventType: 'pull_request', state: 'open' });
    add('review', `${subject}.review_submitted`, 80, {
      state: 'open',
      eventType: 'pull_request_review',
    });
    add('neighbour', `${subject}0.closed`, 90, {});
    add('outside-range', `${subject}/closed`, 90, {});
    add('other-source', `${subject}.closed`, 90, {}, 'other');
    add('unfamiliar', `${subject}.future_action`, 40, {
      eventType: 'pull_request',
      state: 'closed',
    });
    add('poll-only', `${subject}1.POLLED`, 10, { state: 'open' });
    add('opened-only', `${subject}2.opened`, 10, {});
    add('reopened-only', `${subject}3.reopened`, 10, {});
    add('tie-old-ingest', `${subject}4.closed`, 50, {}, 'github', 49);
    add('tie-first', `${subject}4.polled`, 50, { state: 'open' }, 'github', 50);
    add(
      'tie-last',
      `${subject}4.unknown`,
      50,
      { eventType: 'pull_request', state: 'closed' },
      'github',
      50
    );
    add('earlier-close', `${subject}5.closed`, 10, {});
    add('later-sync', `${subject}5.synchronize`, 20, { eventType: 'pull_request', state: 'open' });
  })();
}

export function observeLatestPrState(db: Database, value: string) {
  let sql = '';
  let bindings: (string | number)[] = [];
  const captured = {
    prepare(statement: string) {
      sql = statement;
      return {
        get(...values: (string | number)[]) {
          bindings = values;
          return db.prepare(statement).get(...values);
        },
      };
    },
  };
  const record = new SessionExternalEventStore(captured as unknown as Database).latestPrState(
    value
  );
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[];
  return { record, sql, bindings, plan: plan.map((row) => row.detail) };
}

export function hasTopicSearches(plan: string[]): boolean {
  const searches = plan.filter((detail) =>
    detail.includes(`SEARCH session_external_events USING INDEX ${topicIndex}`)
  );
  return (
    searches.some((detail) => /source=\? AND <expr>=\?/.test(detail)) &&
    searches.some((detail) => /source=\? AND <expr>>\? AND <expr><\?/.test(detail))
  );
}
