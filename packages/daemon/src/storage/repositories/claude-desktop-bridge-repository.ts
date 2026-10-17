import superpipe, { type PipelineAPI } from 'superpipe';
import { canonicalJson } from '../../lib/agent/prompt-comparison.ts';
import type { createClaudeDesktopModsServer } from '../../lib/drivers/claude-desktop-mods-server.ts';
import { withBusyRetry } from '../busy-retry.ts';
import type { Database } from '../sqlite-compat.ts';

type Persist = Parameters<typeof createClaudeDesktopModsServer>[0]['persist'];
type Exchange = Parameters<Persist>[0];
type Event = Exchange['events'][number];
interface Snapshot {
  phase: 'unknown' | 'busy' | 'idle' | 'ended';
  turnId: string | null;
}
interface Checkpoint {
  instanceId: string;
  ownerPid: number;
  sequence: number;
  retired: boolean;
  state: Snapshot;
}
interface Stored {
  checkpoint: Checkpoint | null;
  events: Map<number, string>;
}
interface Plan {
  exchange: Exchange;
  ownerPid: number;
  sequence: number;
  state: Snapshot;
  fresh: Event[];
  create: boolean;
}
class DesktopBridgeConflict extends Error {}

function reduceEvent(state: Snapshot, event: Event): Snapshot {
  if (event.kind === 'session.end') return { phase: 'ended', turnId: null };
  if (event.kind === 'turn.start') return { phase: 'busy', turnId: event.turnId! };
  if (
    event.kind === 'turn.complete' &&
    state.phase !== 'ended' &&
    (state.turnId === null || state.turnId === event.turnId)
  )
    return { phase: 'idle', turnId: null };
  return state;
}
function planEvents(
  exchange: Exchange,
  ownerPid: number,
  stored: Stored
): { value: Plan } | { reason: DesktopBridgeConflict } {
  const checkpoint = stored.checkpoint;
  if (
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    checkpoint?.retired ||
    (checkpoint && checkpoint.ownerPid !== ownerPid)
  )
    return { reason: new DesktopBridgeConflict('Desktop bridge instance or owner changed') };
  if (
    !checkpoint &&
    (exchange.events[0]?.sequence !== 1 || exchange.events[0]?.kind !== 'session.start')
  )
    return {
      reason: new DesktopBridgeConflict(
        'New Desktop bridge instance requires session.start at sequence 1'
      ),
    };
  let sequence = checkpoint?.sequence ?? 0;
  let state: Snapshot = checkpoint?.state ?? { phase: 'unknown', turnId: null };
  const fresh: Event[] = [];
  for (const event of exchange.events) {
    if (event.sequence <= (checkpoint?.sequence ?? 0)) {
      if (stored.events.get(event.sequence) !== canonicalJson(event))
        return { reason: new DesktopBridgeConflict('Conflicting Desktop bridge event replay') };
      continue;
    }
    if (event.sequence !== sequence + 1)
      return { reason: new DesktopBridgeConflict('Desktop bridge event sequence gap') };
    sequence = event.sequence;
    state = reduceEvent(state, event);
    fresh.push(event);
  }
  return { value: { exchange, ownerPid, sequence, state, fresh, create: !checkpoint } };
}
function loadStored(exchange: Exchange, repository: ClaudeDesktopBridgeRepository): Stored {
  return repository.load(exchange);
}
function commitPlan(plan: Plan, repository: ClaudeDesktopBridgeRepository) {
  repository.commit(plan);
  return { ack: plan.sequence };
}
const persistDesktopBridgeEvents = (
  superpipe({})('persist-claude-desktop-bridge-events') as PipelineAPI
)
  .input(['exchange', 'ownerPid', 'repository'])
  .pipe(loadStored, ['exchange', 'repository'], 'stored')
  .pipe(planEvents, ['exchange', 'ownerPid', 'stored'], 'result:outcome')
  .pipe(commitPlan, ['outcome', 'repository'], 'outcome')
  .end('outcome') as (
  exchange: Exchange,
  ownerPid: number,
  repository: ClaudeDesktopBridgeRepository
) => { ack: number } | DesktopBridgeConflict;

export class ClaudeDesktopBridgeRepository {
  constructor(private readonly db: Database) {}

  persist(exchange: Exchange, ownerPid: number): { ack: number } {
    return withBusyRetry(() =>
      this.db.transaction(() => {
        const result = persistDesktopBridgeEvents(exchange, ownerPid, this);
        if (result instanceof Error) throw result;
        return result;
      }, 'immediate')()
    );
  }

  active(sessionId: string): Checkpoint | null {
    const row = this.db
      .prepare('SELECT * FROM claude_desktop_bridge_instances WHERE session_id = ? AND retired = 0')
      .get(sessionId);
    return row ? this.checkpoint(row as Record<string, unknown>) : null;
  }

  events(sessionId: string, instanceId: string): Event[] {
    return (
      this.db
        .prepare(
          'SELECT event_json FROM claude_desktop_bridge_events WHERE session_id = ? AND instance_id = ? ORDER BY sequence'
        )
        .all(sessionId, instanceId) as { event_json: string }[]
    ).map((row) => JSON.parse(row.event_json) as Event);
  }

  load(exchange: Exchange): Stored {
    const row = this.db
      .prepare(
        'SELECT * FROM claude_desktop_bridge_instances WHERE session_id = ? AND instance_id = ?'
      )
      .get(exchange.sessionId, exchange.instanceId);
    const first = exchange.events[0]?.sequence ?? 0;
    const last = exchange.events.at(-1)?.sequence ?? 0;
    const events = this.db
      .prepare(
        'SELECT sequence, event_json FROM claude_desktop_bridge_events WHERE session_id = ? AND instance_id = ? AND sequence BETWEEN ? AND ?'
      )
      .all(exchange.sessionId, exchange.instanceId, first, last) as {
      sequence: number;
      event_json: string;
    }[];
    return {
      checkpoint: row ? this.checkpoint(row as Record<string, unknown>) : null,
      events: new Map(events.map((entry) => [entry.sequence, entry.event_json])),
    };
  }

  commit(plan: Plan): void {
    const { exchange, ownerPid, sequence, state, fresh } = plan;
    const now = Date.now();
    if (plan.create) {
      this.db
        .prepare(
          'UPDATE claude_desktop_bridge_instances SET retired = 1, updated_at = ? WHERE session_id = ? AND retired = 0'
        )
        .run(now, exchange.sessionId);
      this.db
        .prepare(
          'INSERT INTO claude_desktop_bridge_instances (session_id, instance_id, owner_pid, last_sequence, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)'
        )
        .run(exchange.sessionId, exchange.instanceId, ownerPid, canonicalJson(state), now);
    }
    const insert = this.db.prepare(
      'INSERT INTO claude_desktop_bridge_events (session_id, instance_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const event of fresh)
      insert.run(
        exchange.sessionId,
        exchange.instanceId,
        event.sequence,
        canonicalJson(event),
        now
      );
    this.db
      .prepare(
        'UPDATE claude_desktop_bridge_instances SET last_sequence = ?, state_json = ?, updated_at = ? WHERE session_id = ? AND instance_id = ?'
      )
      .run(sequence, canonicalJson(state), now, exchange.sessionId, exchange.instanceId);
  }

  private checkpoint(row: Record<string, unknown>): Checkpoint {
    return {
      instanceId: row.instance_id as string,
      ownerPid: row.owner_pid as number,
      sequence: row.last_sequence as number,
      retired: row.retired === 1,
      state: JSON.parse(row.state_json as string) as Snapshot,
    };
  }
}
