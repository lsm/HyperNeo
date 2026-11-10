import {
  spaceSlotSkillVetoes,
  spaceWorkspaceSources,
} from '../repositories/space-storage-hooks.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SchemaExtension } from './extensions.ts';
import { runMigration239 } from './m239-rename-worker-coder-template-key.ts';
import { runMigration240 } from './m240-space-manager-handle.ts';
import { runMigration242 } from './m242-task-list-indexes.ts';
import { runMigration243 } from './m243-space-agent-template-space-key.ts';
import { runMigration244 } from './m244-backfill-template-ownership.ts';
import { runMigration245 } from './m245-reminder-space-index.ts';
import { runMigration246 } from './m246-template-version-seq-space-key.ts';
import { runMigration247 } from './m247-pending-completion-generation.ts';
import { runMigration249 } from './m249-resolve-template-sentinel-rows.ts';
import { runMigration261 } from './m261-task-list-updated-indexes.ts';
import { runMigration265 } from './m265-workflow-run-blocked-retries.ts';
import { runMigration267 } from './m267-restamp-contracts-task-approve.ts';
import { runMigration268 } from './m268-rename-agent-forge-scopes.ts';
import { runMigration269 } from './m269-restamp-goal-task-trigger.ts';
import { runMigration270 } from './m270-restamp-contracts-task-transition-review.ts';
import { runMigration271 } from './m271-relocate-built-in-key-templates.ts';
import { runMigration273 } from './m273-backfill-agent-session-ids.ts';
import { runMigration274 } from './m274-convert-ad-hoc-space-sessions.ts';
import { runMigration275 } from './m275-link-agent-owned-sessions.ts';
import { runMigration276 } from './m276-relocate-space-manager-template.ts';
import { runMigration277 } from './m277-archive-orphaned-agent-sessions.ts';
import { runMigration303 } from './m303-external-delivery-task-index.ts';
import { runMigration312 } from './m312-drop-artifact-cache.ts';
import { runMigration406 } from './m406-goal-owner-session.ts';
import { runMigration420 } from './m420-neo-ask-goal.ts';
import { runMigration444 } from './m444-neo-goals.ts';
import { migrateStandaloneTaskOwnership } from '../tasks/ownership-migration.ts';
import { runMigration272 } from './m272-space-session-event-subscriptions.ts';
import { runMigration281 } from './m281-space-agent-template-hides.ts';
import spaceBaseline from './baseline-space-v041.json' with { type: 'json' };
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

function createAgentMemoryTables(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_memory (
			id INTEGER PRIMARY KEY,
			key TEXT NOT NULL,
			space_id TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			created_by_session TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			access_count INTEGER NOT NULL DEFAULT 0,
			last_accessed_at INTEGER,
			embedding_status TEXT NOT NULL DEFAULT 'pending'
				CHECK(embedding_status IN ('pending', 'ready', 'failed')),
			embedding_model TEXT,
			embedding_updated_at INTEGER,
			embedding_error TEXT,
			embedding_revision INTEGER NOT NULL DEFAULT 0,
			embedding_token TEXT NOT NULL DEFAULT '',
			UNIQUE(space_id, key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS space_agent_memory_fts USING fts5(
			key,
			content,
			tags,
			content='space_agent_memory',
			content_rowid='id',
			tokenize='trigram'
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_vectors (
			memory_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			model TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_core_memory (
			space_id TEXT NOT NULL,
			memory_id INTEGER NOT NULL,
			score REAL NOT NULL,
			rank INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, memory_id),
			UNIQUE(space_id, rank),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_ai
		AFTER INSERT ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_ad
		AFTER DELETE ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_au
		AFTER UPDATE OF key, content, tags ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END
	`);
}

function createSpaceTables(db: BunDatabase): void {
  createAgentMemoryTables(db);
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
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_space ON space_agent_memory(space_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_updated ON space_agent_memory(space_id, updated_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_access ON space_agent_memory(space_id, last_accessed_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_embedding_status ON space_agent_memory(space_id, embedding_status)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_core_memory_rank ON space_agent_core_memory(space_id, rank)`
  );
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
  baseline: { statements: spaceBaseline, presentWhenTable: 'spaces' },
  sessionSkillVetoes: spaceSlotSkillVetoes,
  workspaceSources: spaceWorkspaceSources,
  migrations: {
    migration_239: runMigration239,
    migration_240: runMigration240,
    migration_241: migrateStandaloneTaskOwnership,
    migration_242: runMigration242,
    migration_243: runMigration243,
    migration_244: runMigration244,
    migration_245: runMigration245,
    migration_246: runMigration246,
    migration_247: runMigration247,
    migration_248: runMigration248,
    migration_249: runMigration249,
    migration_250: runMigration250,
    migration_251: runMigration251,
    migration_252: runMigration252,
    migration_253: runMigration253,
    migration_254: runMigration254,
    migration_255: runMigration255,
    migration_256: runMigration256,
    migration_257: runMigration257,
    migration_258: runMigration258,
    migration_260: runMigration260,
    migration_261: runMigration261,
    migration_265: runMigration265,
    migration_267: runMigration267,
    migration_268: runMigration268,
    migration_269: runMigration269,
    migration_270: runMigration270,
    migration_271: runMigration271,
    migration_272: runMigration272,
    migration_273: runMigration273,
    migration_274: runMigration274,
    migration_275: runMigration275,
    migration_276: runMigration276,
    migration_277: runMigration277,
    migration_281: runMigration281,
    migration_303: runMigration303,
    migration_312: runMigration312,
    migration_406: runMigration406,
    space_migration_420: runMigration420,
    space_migration_444: runMigration444,
  },
};
