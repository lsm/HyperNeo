import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SchemaExtension } from './extensions.ts';
import { createEvolutionTables } from './evolution.ts';
import { createLongHorizonAgentTables } from './long-horizon-agents.ts';
import { createSpaceSessionEventSubscriptionTables } from './space-session-event-subscriptions.ts';
import { createSpaceAgentTemplatesTable } from './space-agent-templates.ts';
import { createWorkflowEventSubscriptionTables } from './workflow-event-subscriptions.ts';
import { runMigration248 } from './m248-direct-task-execution.ts';
import { runMigration250 } from './m250-direct-stop-requests.ts';
import { runMigration251 } from './m251-direct-session-provenance.ts';
import { runMigration252 } from './m252-direct-kickoff-intents.ts';
import { runMigration253 } from './m253-direct-kickoff-dispatches.ts';
import { runMigration254 } from './m254-direct-stop-verification.ts';
import { runMigration255 } from './m255-task-lifecycle-generation.ts';
import { runMigration256 } from './m256-direct-finalization.ts';
import { runMigration257 } from './m257-direct-outcome-job.ts';
import { runMigration258 } from './m258-direct-process-ownership.ts';
import { runMigration260 } from './m260-direct-start-requests.ts';

function createSpaceTables(db: BunDatabase): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS space_goals (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'paused', 'completed', 'archived')),
        type TEXT NOT NULL DEFAULT 'one_shot'
          CHECK(type IN ('one_shot', 'measurable', 'recurring')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
        labels TEXT NOT NULL DEFAULT '[]',
        metrics TEXT NOT NULL DEFAULT '{}',
        summary TEXT NOT NULL DEFAULT '',
        progress INTEGER NOT NULL DEFAULT 0,
        next_steps TEXT NOT NULL DEFAULT '[]',
        preferred_workflow_id TEXT,
        task_schedule_id TEXT,
        auto_trigger_next INTEGER NOT NULL DEFAULT 0,
        pending_next_run INTEGER NOT NULL DEFAULT 0,
        active_task_id TEXT,
        last_task_id TEXT,
        last_check_in_at INTEGER,
        next_check_in_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0,
        owner_session_id TEXT,
        done_test TEXT,
        mandate_ref TEXT,
        mandate_rev TEXT,
        works_note TEXT,
        works_note_through INTEGER,
        facts_lines TEXT,
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
      )
    `);
  db.exec(`
	      CREATE TABLE IF NOT EXISTS space_goal_events (
	        id TEXT PRIMARY KEY,
	        space_id TEXT,
	        goal_id TEXT NOT NULL,
	        event_type TEXT NOT NULL
	          CHECK(event_type IN ('created', 'updated', 'status_changed', 'task_triggered', 'task_queued', 'task_terminal', 'schedule_updated', 'journal_compacted')),
	        source TEXT NOT NULL
	          CHECK(source IN ('rpc', 'space_agent_tool', 'workflow_node_agent', 'scheduler', 'system', 'neo', 'human')),
	        source_task_id TEXT,
	        source_session_id TEXT,
	        previous_state TEXT,
	        new_state TEXT,
	        diff TEXT,
	        note TEXT,
	        created_at INTEGER NOT NULL,
	        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
	        FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
	        FOREIGN KEY (source_task_id) REFERENCES space_tasks(id) ON DELETE SET NULL
	      )
	    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS space_goal_outcome_notifications (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        terminal_generation INTEGER NOT NULL DEFAULT 0,
        goal_revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'superseded', 'acknowledged', 'rejected')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(goal_id, task_id, terminal_generation),
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS space_agent_inactivity_config (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        threshold_ms INTEGER,
        prompt TEXT,
        config_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id, agent_id),
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS space_agent_inactivity_claims (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        claim_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'accepted'
          CHECK(state IN ('none', 'accepted', 'in_flight')),
        window_anchored_at INTEGER NOT NULL,
        attempt_generation INTEGER NOT NULL DEFAULT 0,
        owner_token TEXT,
        config_revision INTEGER,
        degraded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id, agent_id),
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
      )
    `);
  createEvolutionTables(db);
  createLongHorizonAgentTables(db);
  createSpaceSessionEventSubscriptionTables(db);
  createSpaceAgentTemplatesTable(db);
  createWorkflowEventSubscriptionTables(db);
  runMigration248(db);
  runMigration250(db);
  runMigration251(db);
  runMigration252(db);
  runMigration253(db);
  runMigration254(db);
  runMigration255(db);
  runMigration256(db);
  runMigration257(db);
  runMigration258(db);
  runMigration260(db);
}

function createSpaceIndexes(db: BunDatabase): void {
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_space_agent_inactivity_claims_space
      ON space_agent_inactivity_claims(space_id, agent_id)
    `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goals_next_check_in ON space_goals(status, next_check_in_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_space_created ON space_goal_events(space_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_source_task ON space_goal_events(source_task_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_goal_pending
      ON space_goal_outcome_notifications(goal_id, status, created_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_task
      ON space_goal_outcome_notifications(task_id, terminal_generation)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_pending_created
      ON space_goal_outcome_notifications(status, created_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_space_pending
      ON space_goal_outcome_notifications(space_id, status, created_at)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_space ON space_goals(space_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_schedule ON space_goals(task_schedule_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_active_task ON space_goals(active_task_id)`);
}

export const SPACE_SCHEMA: SchemaExtension = {
  id: 'space',
  tables: createSpaceTables,
  indexes: createSpaceIndexes,
};
