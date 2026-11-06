import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createSpaceExternalEvents } from '../../../../../space/src/external-event-wiring.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('createSpaceExternalEvents', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE space_session_event_subscriptions (
        id TEXT PRIMARY KEY, space_id TEXT, session_id TEXT, topic TEXT, label TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE space_workflow_event_subscriptions (
        id TEXT PRIMARY KEY, space_id TEXT, workflow_run_id TEXT, task_id TEXT, node_id TEXT,
        agent_name TEXT, topic TEXT, subscription_kind TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE space_long_horizon_agent_event_subscriptions (
        id TEXT PRIMARY KEY, space_id TEXT, agent_id TEXT, source TEXT, topic TEXT,
        filter_json TEXT DEFAULT '{}', status TEXT, created_at INTEGER, updated_at INTEGER
      );
      INSERT INTO space_session_event_subscriptions (id, space_id, topic, created_at)
        VALUES ('s', 'space-1', 'github/acme/app/pr/1', 1), ('other', 'space-2', 'github/x/y/pr/9', 1);
      INSERT INTO space_workflow_event_subscriptions (id, space_id, topic, created_at)
        VALUES ('w', 'space-1', 'github/acme/app/pr/2', 1);
      INSERT INTO space_long_horizon_agent_event_subscriptions
        (id, space_id, source, topic, status, created_at)
        VALUES ('a', 'space-1', 'custom', 'ping', 'active', 1),
               ('bad', 'space-1', 'custom', 'github/acme/app', 'active', 2),
               ('paused', 'space-1', 'custom', 'quiet', 'paused', 3);
    `);
  });
  afterEach(() => db.close());

  it('lists one space topics and skips an agent topic that cannot compose', () => {
    const events = createSpaceExternalEvents(
      db,
      createReactiveDatabase({ getDatabase: () => db } as never),
      new InternalEventBus()
    );
    expect(events.subscribedTopics('space-1')).toEqual([
      'github/acme/app/pr/1',
      'github/acme/app/pr/2',
      'custom/ping',
    ]);
  });
});
