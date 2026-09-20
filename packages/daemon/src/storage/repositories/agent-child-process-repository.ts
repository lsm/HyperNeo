import type { PersistedAgentChild } from '../../lib/agent/orphan-child-sweep.ts';
import { withBusyRetry } from '../busy-retry.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export class AgentChildProcessRepository {
  constructor(private db: BunDatabase) {}

  record(child: PersistedAgentChild): void {
    withBusyRetry(() =>
      this.db
        .prepare(
          `INSERT INTO agent_child_processes (pid, session_id, command, started_at, daemon_pid)
             VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(pid) DO UPDATE SET
             session_id = excluded.session_id, command = excluded.command,
             started_at = excluded.started_at, daemon_pid = excluded.daemon_pid`
        )
        .run(child.pid, child.sessionId, child.command, child.startedAt, child.daemonPid)
    );
  }

  forget(pid: number): void {
    withBusyRetry(() =>
      this.db.prepare(`DELETE FROM agent_child_processes WHERE pid = ?`).run(pid)
    );
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

  forgetMany(pids: readonly number[]): void {
    if (pids.length === 0) return;
    const placeholders = pids.map(() => '?').join(',');
    withBusyRetry(() =>
      this.db
        .prepare(`DELETE FROM agent_child_processes WHERE pid IN (${placeholders})`)
        .run(...pids)
    );
  }
}
