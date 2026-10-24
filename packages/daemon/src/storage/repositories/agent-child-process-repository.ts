import type { PersistedAgentChild } from '../../lib/agent/orphan-child-sweep.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export const recordAgentChild = defineDbOp({
  name: 'agentChild.record',
  mode: 'write',
  run: (db: BunDatabase, child: PersistedAgentChild): void => {
    db.prepare(
      `INSERT INTO agent_child_processes (pid, session_id, command, started_at, daemon_pid)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pid) DO UPDATE SET
         session_id = excluded.session_id, command = excluded.command,
         started_at = excluded.started_at, daemon_pid = excluded.daemon_pid`
    ).run(child.pid, child.sessionId, child.command, child.startedAt, child.daemonPid);
  },
});

export const forgetAgentChildren = defineDbOp({
  name: 'agentChild.forget',
  mode: 'write',
  run: (db: BunDatabase, pids: readonly number[]): void => {
    db.prepare(
      `DELETE FROM agent_child_processes WHERE pid IN (${pids.map(() => '?').join(',')})`
    ).run(...pids);
  },
});

export class AgentChildProcessRepository {
  constructor(private db: BunDatabase) {}

  record(child: PersistedAgentChild): Promise<void> {
    return gatewayFor(this.db).run(recordAgentChild, child);
  }

  forget(pid: number): Promise<void> {
    return this.forgetMany([pid]);
  }

  list(): PersistedAgentChild[] {
    const rows = this.db
      .prepare(
        `SELECT pid, session_id, command, started_at, daemon_pid
           FROM agent_child_processes ORDER BY pid ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      pid: row.pid as number,
      sessionId: row.session_id as string,
      command: row.command as string,
      startedAt: row.started_at as number,
      daemonPid: row.daemon_pid as number,
    }));
  }

  async forgetMany(pids: readonly number[]): Promise<void> {
    if (pids.length > 0) await gatewayFor(this.db).run(forgetAgentChildren, pids);
  }
}
