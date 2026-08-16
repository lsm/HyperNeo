import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import {
  buildScopeFilter,
  getAccessibleTableNames,
  getBlacklistedColumns,
  getExcludedTableNames,
  getScopeConfig,
  getScopeForSession,
  type ScopeTableConfig,
} from '@/lib/db-query/scope-config';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tableNames(configs: ScopeTableConfig[]): string[] {
  return configs.map((c) => c.tableName);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scope-config', () => {
  // ── getScopeConfig ────────────────────────────────────────────────────────

  describe('getScopeConfig', () => {
    it('global scope returns the correct set of tables', () => {
      const config = getScopeConfig('global');
      const names = tableNames(config);
      expect(names).toEqual([
        'sessions',
        'rooms',
        'spaces',
        'app_mcp_servers',
        'skills',
        'inbox_items',
        'job_queue',
        'short_id_counters',
      ]);
      expect(names).toHaveLength(8);
    });

    it('room scope returns the correct set of tables', () => {
      const config = getScopeConfig('room');
      const names = tableNames(config);
      expect(names).toEqual([
        'tasks',
        'goals',
        'mission_executions',
        'mission_metric_history',
        'room_github_mappings',
        'room_mcp_enablement',
        'room_skill_overrides',
      ]);
      expect(names).toHaveLength(7);
    });

    it('space scope returns the correct set of tables', () => {
      const config = getScopeConfig('space');
      const names = tableNames(config);
      expect(names).toEqual([
        'space_agents',
        'space_workflows',
        'space_workflow_nodes',
        'space_workflow_runs',
        'space_tasks',
        'space_goals',
        'space_goal_events',
        'space_worktrees',
        'space_workspaces',
        'workflow_hook_state',
        'workflow_hook_result_artifacts',
        'channel_cycles',
        'channel_cycle_events',
        'workflow_run_artifacts',
        'workflow_run_artifact_cache',
        'mcp_audit_log',
        'task_schedules',
        'space_agent_memory',
        'space_agent_core_memory',
        'evolution_scopes',
        'evolution_evidence',
        'evolution_episodes',
        'evolution_lessons',
        'evolution_task_proposals',
        'evolution_metric_snapshots',
        'goal_automation_cursors',
        // Main-DB tables exposed with space-scoped filtering via session ID prefix:
        'sessions',
        'sdk_messages',
        'session_groups',
        'session_group_members',
      ]);
      expect(names).toHaveLength(30);
    });

    it('all table configs have a description', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        for (const table of getScopeConfig(scopeType)) {
          expect(table.description.length).toBeGreaterThan(0);
        }
      }
    });
  });

  // ── Column blacklists ─────────────────────────────────────────────────────

  describe('column blacklists', () => {
    it('sessions blacklist excludes config and session_context', () => {
      const sessions = getScopeConfig('global').find((t) => t.tableName === 'sessions')!;
      expect(sessions.blacklistedColumns).toContain('config');
      expect(sessions.blacklistedColumns).toContain('session_context');
    });

    it('rooms blacklist excludes config', () => {
      const rooms = getScopeConfig('global').find((t) => t.tableName === 'rooms')!;
      expect(rooms.blacklistedColumns).toEqual(['config']);
    });

    it('tasks blacklist excludes restrictions (internal use)', () => {
      const tasks = getScopeConfig('room').find((t) => t.tableName === 'tasks')!;
      expect(tasks.blacklistedColumns).toContain('restrictions');
    });

    it('app_mcp_servers blacklist excludes env', () => {
      const mcp = getScopeConfig('global').find((t) => t.tableName === 'app_mcp_servers')!;
      expect(mcp.blacklistedColumns).toEqual(['env']);
    });

    it('inbox_items blacklist excludes raw_event and security_check', () => {
      const inbox = getScopeConfig('global').find((t) => t.tableName === 'inbox_items')!;
      expect(inbox.blacklistedColumns).toContain('raw_event');
      expect(inbox.blacklistedColumns).toContain('security_check');
    });

    it('space_workflows blacklist excludes config, gates, and channels', () => {
      const wf = getScopeConfig('space').find((t) => t.tableName === 'space_workflows')!;
      expect(wf.blacklistedColumns).toContain('config');
      expect(wf.blacklistedColumns).toContain('gates');
      expect(wf.blacklistedColumns).toContain('channels');
    });

    it('space_workflow_nodes blacklist excludes config', () => {
      const nodes = getScopeConfig('space').find((t) => t.tableName === 'space_workflow_nodes')!;
      expect(nodes.blacklistedColumns).toEqual(['config']);
    });

    it('getBlacklistedColumns returns empty array for tables with no blacklist', () => {
      expect(getBlacklistedColumns('skills')).toEqual([]);
      expect(getBlacklistedColumns('goals')).toEqual([]);
      expect(getBlacklistedColumns('nonexistent_table')).toEqual([]);
    });

    it('getBlacklistedColumns returns correct blacklist for known tables', () => {
      expect(getBlacklistedColumns('sessions')).toContain('config');
      expect(getBlacklistedColumns('app_mcp_servers')).toContain('env');
      expect(getBlacklistedColumns('space_agents')).toContain('system_prompt');
      expect(getBlacklistedColumns('job_queue')).toContain('payload');
      expect(getBlacklistedColumns('tasks')).toContain('restrictions');
    });
  });

  // ── getScopeForSession ────────────────────────────────────────────────────

  describe('getScopeForSession', () => {
    it('maps roomId to room scope', () => {
      const result = getScopeForSession({ roomId: 'room-123' });
      expect(result).toEqual({ scopeType: 'room', scopeValue: 'room-123' });
    });

    it('maps spaceId to space scope when no roomId', () => {
      const result = getScopeForSession({ spaceId: 'space-456' });
      expect(result).toEqual({ scopeType: 'space', scopeValue: 'space-456' });
    });

    it('prefers roomId over spaceId when both are present', () => {
      const result = getScopeForSession({ roomId: 'room-1', spaceId: 'space-2' });
      expect(result).toEqual({ scopeType: 'room', scopeValue: 'room-1' });
    });

    it('returns global scope when neither roomId nor spaceId', () => {
      const result = getScopeForSession({});
      expect(result).toEqual({ scopeType: 'global', scopeValue: '' });
    });

    it('returns global scope when only other fields are present', () => {
      const result = getScopeForSession({ lobbyId: 'lobby-1', taskId: 'task-1' });
      expect(result).toEqual({ scopeType: 'global', scopeValue: '' });
    });
  });

  // ── Sensitive tables never in any scope ───────────────────────────────────

  describe('sensitive table exclusion', () => {
    it('auth_config is not in any scope', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        const names = getAccessibleTableNames(scopeType);
        expect(names).not.toContain('auth_config');
      }
    });

    it('global_tools_config is not in any scope', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        expect(getAccessibleTableNames(scopeType)).not.toContain('global_tools_config');
      }
    });

    it('global_settings is not in any scope', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        expect(getAccessibleTableNames(scopeType)).not.toContain('global_settings');
      }
    });

    it('sdk_messages is accessible in space scope (with session ID prefix filtering)', () => {
      // sdk_messages is now exposed in space scope (filtered by session_id LIKE 'space:<id>:%')
      expect(getAccessibleTableNames('space')).toContain('sdk_messages');
      // But NOT in global or room scope
      expect(getAccessibleTableNames('global')).not.toContain('sdk_messages');
      expect(getAccessibleTableNames('room')).not.toContain('sdk_messages');
    });

    it('session_groups and session_group_members are accessible in space scope only', () => {
      // Now exposed in space scope via session ID prefix filtering
      expect(getAccessibleTableNames('space')).toContain('session_groups');
      expect(getAccessibleTableNames('space')).toContain('session_group_members');
      // But NOT in global or room scope
      expect(getAccessibleTableNames('global')).not.toContain('session_groups');
      expect(getAccessibleTableNames('global')).not.toContain('session_group_members');
      expect(getAccessibleTableNames('room')).not.toContain('session_groups');
      expect(getAccessibleTableNames('room')).not.toContain('session_group_members');
    });

    it('task_group_events is not in any scope', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        expect(getAccessibleTableNames(scopeType)).not.toContain('task_group_events');
      }
    });

    it('node_executions is not in any scope', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        expect(getAccessibleTableNames(scopeType)).not.toContain('node_executions');
      }
    });
  });

  // ── Dropped tables ────────────────────────────────────────────────────────

  describe('dropped tables', () => {
    const droppedTables = [
      'space_session_groups',
      'space_session_group_members',
      'space_workflow_transitions',
    ];

    it('dropped tables are not in any scope config', () => {
      for (const scopeType of ['global', 'room', 'space'] as const) {
        const names = getAccessibleTableNames(scopeType);
        for (const table of droppedTables) {
          expect(names).not.toContain(table);
        }
      }
    });

    it('dropped tables are in getExcludedTableNames', () => {
      const excluded = getExcludedTableNames();
      for (const table of droppedTables) {
        expect(excluded).toContain(table);
      }
    });
  });

  // ── getExcludedTableNames ─────────────────────────────────────────────────

  describe('getExcludedTableNames', () => {
    it('includes all sensitive tables', () => {
      const excluded = getExcludedTableNames();
      expect(excluded).toContain('auth_config');
      expect(excluded).toContain('global_tools_config');
      expect(excluded).toContain('global_settings');
    });

    it('does not include sdk_messages (now in space scope)', () => {
      // sdk_messages is no longer globally excluded — it's accessible in space scope
      // with session ID prefix filtering. It remains inaccessible in global/room scopes.
      expect(getExcludedTableNames()).not.toContain('sdk_messages');
    });

    it('does not include session_groups or session_group_members (now in space scope)', () => {
      // These tables are now accessible in space scope with session ID prefix filtering.
      expect(getExcludedTableNames()).not.toContain('session_groups');
      expect(getExcludedTableNames()).not.toContain('session_group_members');
    });

    it('includes remaining internal infrastructure tables', () => {
      const excluded = getExcludedTableNames();
      expect(excluded).toContain('task_group_events');
      expect(excluded).toContain('node_executions');
    });

    it('includes all dropped tables', () => {
      const excluded = getExcludedTableNames();
      expect(excluded).toContain('space_session_groups');
      expect(excluded).toContain('space_session_group_members');
      expect(excluded).toContain('space_workflow_transitions');
      expect(excluded).toContain('messages');
      expect(excluded).toContain('tool_calls');
    });

    it('includes dynamically created tables', () => {
      const excluded = getExcludedTableNames();
      expect(excluded).toContain('github_filter_configs');
    });

    it('includes external event bus tables', () => {
      const excluded = getExcludedTableNames();
      expect(excluded).toContain('external_event_source_configs');
      expect(excluded).toContain('external_event_extension_configs');
      expect(excluded).toContain('space_external_event_source_configs');
      expect(excluded).toContain('space_external_events');
      expect(excluded).toContain('space_external_event_deliveries');
    });

    it('returns a non-empty array', () => {
      expect(getExcludedTableNames().length).toBeGreaterThan(0);
    });

    it('excluded tables do not overlap with any accessible tables', () => {
      const excluded = new Set(getExcludedTableNames());
      for (const scopeType of ['global', 'room', 'space'] as const) {
        const accessible = getAccessibleTableNames(scopeType);
        for (const name of accessible) {
          expect(excluded.has(name)).toBe(false);
        }
      }
    });
  });

  // ── buildScopeFilter ──────────────────────────────────────────────────────

  describe('buildScopeFilter', () => {
    it('returns empty filter for global scope tables (no scopeColumn or scopeJoin)', () => {
      const sessions = getScopeConfig('global').find((t) => t.tableName === 'sessions')!;
      const result = buildScopeFilter(sessions, 'unused');
      expect(result).toEqual({ whereClause: '', params: [] });
    });

    it('produces direct scope filter for room-scoped tables with scopeColumn', () => {
      const tasks = getScopeConfig('room').find((t) => t.tableName === 'tasks')!;
      expect(tasks.scopeColumn).toBe('room_id');
      const result = buildScopeFilter(tasks, 'room-abc');
      expect(result.whereClause).toBe('room_id = ?');
      expect(result.params).toEqual(['room-abc']);
    });

    it('produces direct scope filter for goals', () => {
      const goals = getScopeConfig('room').find((t) => t.tableName === 'goals')!;
      const result = buildScopeFilter(goals, 'room-xyz');
      expect(result.whereClause).toBe('room_id = ?');
      expect(result.params).toEqual(['room-xyz']);
    });

    it('produces direct scope filter for space-scoped tables', () => {
      const agents = getScopeConfig('space').find((t) => t.tableName === 'space_agents')!;
      expect(agents.scopeColumn).toBe('space_id');
      const result = buildScopeFilter(agents, 'space-123');
      expect(result.whereClause).toBe('space_id = ?');
      expect(result.params).toEqual(['space-123']);
    });

    it('produces indirect scope filter for mission_executions via goals', () => {
      const execs = getScopeConfig('room').find((t) => t.tableName === 'mission_executions')!;
      expect(execs.scopeJoin).toBeDefined();
      expect(execs.scopeJoin!.localColumn).toBe('goal_id');
      expect(execs.scopeJoin!.joinTable).toBe('goals');
      expect(execs.scopeJoin!.joinPkColumn).toBe('id');
      expect(execs.scopeJoin!.scopeColumn).toBe('room_id');

      const result = buildScopeFilter(execs, 'room-42');
      expect(result.whereClause).toBe('goal_id IN (SELECT id FROM goals WHERE room_id = ?)');
      expect(result.params).toEqual(['room-42']);
    });

    it('produces indirect scope filter for mission_metric_history via goals', () => {
      const history = getScopeConfig('room').find((t) => t.tableName === 'mission_metric_history')!;
      const result = buildScopeFilter(history, 'room-99');
      expect(result.whereClause).toBe('goal_id IN (SELECT id FROM goals WHERE room_id = ?)');
      expect(result.params).toEqual(['room-99']);
    });

    it('produces indirect scope filter for space_workflow_nodes via space_workflows', () => {
      const nodes = getScopeConfig('space').find((t) => t.tableName === 'space_workflow_nodes')!;
      expect(nodes.scopeJoin).toBeDefined();
      expect(nodes.scopeJoin!.localColumn).toBe('workflow_id');
      expect(nodes.scopeJoin!.joinTable).toBe('space_workflows');
      expect(nodes.scopeJoin!.joinPkColumn).toBe('id');
      expect(nodes.scopeJoin!.scopeColumn).toBe('space_id');

      const result = buildScopeFilter(nodes, 'space-alpha');
      expect(result.whereClause).toBe(
        'workflow_id IN (SELECT id FROM space_workflows WHERE space_id = ?)'
      );
      expect(result.params).toEqual(['space-alpha']);
    });

    it('produces indirect scope filter for channel_cycles via space_workflow_runs', () => {
      const cycles = getScopeConfig('space').find((t) => t.tableName === 'channel_cycles')!;
      expect(cycles.scopeJoin).toBeDefined();
      expect(cycles.scopeJoin!.localColumn).toBe('run_id');

      const result = buildScopeFilter(cycles, 'space-gamma');
      expect(result.whereClause).toBe(
        'run_id IN (SELECT id FROM space_workflow_runs WHERE space_id = ?)'
      );
      expect(result.params).toEqual(['space-gamma']);
    });

    it('produces LIKE filter for sessions in space scope (scopeLike)', () => {
      const sessions = getScopeConfig('space').find((t) => t.tableName === 'sessions')!;
      expect(sessions.scopeLike).toBeDefined();
      expect(sessions.scopeLike!.column).toBe('id');
      expect(sessions.scopeLike!.patternPrefix).toBe('space:');
      expect(sessions.scopeLike!.patternSuffix).toBe(':%');

      const result = buildScopeFilter(sessions, 'abc123');
      expect(result.whereClause).toBe('id LIKE ?');
      expect(result.params).toEqual(['space:abc123:%']);
    });

    it('produces LIKE filter for sdk_messages in space scope', () => {
      const msgs = getScopeConfig('space').find((t) => t.tableName === 'sdk_messages')!;
      expect(msgs.scopeLike).toBeDefined();
      expect(msgs.scopeLike!.column).toBe('session_id');

      const result = buildScopeFilter(msgs, 'space-xyz');
      expect(result.whereClause).toBe('session_id LIKE ?');
      expect(result.params).toEqual(['space:space-xyz:%']);
    });

    it('produces LIKE filter for session_group_members in space scope', () => {
      const sgm = getScopeConfig('space').find((t) => t.tableName === 'session_group_members')!;
      expect(sgm.scopeLike).toBeDefined();

      const result = buildScopeFilter(sgm, 'sid-42');
      expect(result.whereClause).toBe('session_id LIKE ?');
      expect(result.params).toEqual(['space:sid-42:%']);
    });

    it('produces LIKE-based join filter for session_groups in space scope', () => {
      const sg = getScopeConfig('space').find((t) => t.tableName === 'session_groups')!;
      expect(sg.scopeJoin).toBeDefined();
      expect(sg.scopeJoin!.likePrefix).toBe('space:');
      expect(sg.scopeJoin!.likeSuffix).toBe(':%');
      expect(sg.scopeJoin!.localColumn).toBe('id');
      expect(sg.scopeJoin!.joinTable).toBe('session_group_members');
      expect(sg.scopeJoin!.joinPkColumn).toBe('group_id');
      expect(sg.scopeJoin!.scopeColumn).toBe('session_id');

      const result = buildScopeFilter(sg, 'sp99');
      expect(result.whereClause).toBe(
        'id IN (SELECT group_id FROM session_group_members WHERE session_id LIKE ?)'
      );
      expect(result.params).toEqual(['space:sp99:%']);
    });

    it('all LIKE-based scope filters produce the correct pattern', () => {
      const likeConfigs = getScopeConfig('space').filter((c) => c.scopeLike);
      expect(likeConfigs.length).toBeGreaterThan(0);

      for (const cfg of likeConfigs) {
        const result = buildScopeFilter(cfg, 'my-space-id');
        expect(result.whereClause).toContain('LIKE ?');
        expect(result.params).toHaveLength(1);
        expect(result.params[0] as string).toContain('my-space-id');
      }
    });

    it('all indirect scope filters produce valid SQL with one parameter', () => {
      // Collect all indirect configs across all scopes
      const indirectConfigs: ScopeTableConfig[] = [];
      for (const scopeType of ['global', 'room', 'space'] as const) {
        for (const cfg of getScopeConfig(scopeType)) {
          if (cfg.scopeJoin) {
            indirectConfigs.push(cfg);
          }
        }
      }

      expect(indirectConfigs.length).toBeGreaterThan(0);

      for (const cfg of indirectConfigs) {
        const result = buildScopeFilter(cfg, 'test-scope-value');
        // Should contain IN subquery pattern
        expect(result.whereClause).toContain('IN (SELECT');
        expect(result.whereClause).toContain('FROM');
        expect(result.whereClause).toContain('WHERE');
        expect(result.whereClause).toContain('?');
        // Exactly one parameter
        expect(result.params).toHaveLength(1);
        // Standard join: param is the scope value. LIKE-based join: param is the full LIKE pattern.
        if (cfg.scopeJoin?.likePrefix !== undefined) {
          expect(result.params[0] as string).toContain('test-scope-value');
        } else {
          expect(result.params[0]).toBe('test-scope-value');
        }
      }
    });

    it('all direct scope filters produce equality clause with one parameter', () => {
      const directConfigs: ScopeTableConfig[] = [];
      for (const scopeType of ['global', 'room', 'space'] as const) {
        for (const cfg of getScopeConfig(scopeType)) {
          if (cfg.scopeColumn) {
            directConfigs.push(cfg);
          }
        }
      }

      expect(directConfigs.length).toBeGreaterThan(0);

      for (const cfg of directConfigs) {
        const result = buildScopeFilter(cfg, 'test-scope-value');
        expect(result.whereClause).toBe(`${cfg.scopeColumn} = ?`);
        expect(result.params).toHaveLength(1);
        expect(result.params[0]).toBe('test-scope-value');
      }
    });
  });

  // ── Scope filter enforcement ──────────────────────────────────────────────

  describe('scope filter enforcement', () => {
    it('every room-scoped table has scopeColumn or scopeJoin', () => {
      const unfiltered: string[] = [];
      for (const table of getScopeConfig('room')) {
        if (!table.scopeColumn && !table.scopeJoin) {
          unfiltered.push(table.tableName);
        }
      }
      expect(unfiltered).toEqual([]);
    });

    it('every space-scoped table has scopeColumn, scopeJoin, or scopeLike', () => {
      // Tables using scopeLike filter by session ID prefix (e.g., 'space:<id>:%').
      const unfiltered: string[] = [];
      for (const table of getScopeConfig('space')) {
        if (!table.scopeColumn && !table.scopeJoin && !table.scopeLike) {
          unfiltered.push(table.tableName);
        }
      }
      expect(unfiltered).toEqual([]);
    });
  });

  // ── Cross-cutting: intentional multi-scope tables and uniqueness ──────────

  describe('table name uniqueness', () => {
    it('sessions intentionally appears in both global and space scope', () => {
      // `sessions` is in global scope (no filter) AND
      // in space scope (filtered by session ID prefix — space agent access).
      // This is an intentional design: the two scopes apply different filtering.
      expect(getAccessibleTableNames('global')).toContain('sessions');
      expect(getAccessibleTableNames('space')).toContain('sessions');
      expect(getAccessibleTableNames('room')).not.toContain('sessions');
    });

    it('no table other than sessions appears in more than one scope', () => {
      // `sessions` is the only intentional cross-scope table (global + space).
      const INTENTIONAL_MULTI_SCOPE = new Set(['sessions']);

      const allTables = new Map<string, string[]>();
      for (const scopeType of ['global', 'room', 'space'] as const) {
        for (const name of getAccessibleTableNames(scopeType)) {
          const existing = allTables.get(name) ?? [];
          existing.push(scopeType);
          allTables.set(name, existing);
        }
      }

      const unexpectedDuplicates: string[] = [];
      for (const [name, scopes] of allTables) {
        if (scopes.length > 1 && !INTENTIONAL_MULTI_SCOPE.has(name)) {
          unexpectedDuplicates.push(`${name}: ${scopes.join(', ')}`);
        }
      }
      expect(unexpectedDuplicates).toEqual([]);
    });
  });

  // ── Schema evolution: every actual DB table is accounted for ──────────────

  describe('schema evolution', () => {
    it('every table in the actual schema is either in a scope config or in the excluded list', () => {
      // Create a fresh in-memory database with the full schema
      const db = new Database(':memory:');
      runMigrations(db, () => {});
      createTables(db);

      // Query sqlite_master for all actual table names
      const rows = db
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as {
        name: string;
      }[];
      const actualTables = new Set(
        rows
          .map((r) => r.name)
          // Filter out internal SQLite tables (sqlite_sequence is auto-created for AUTOINCREMENT)
          .filter((name) => !name.startsWith('sqlite_'))
      );

      // Collect all tables that are either in a scope config or excluded
      const accountedFor = new Set<string>();
      for (const scopeType of ['global', 'room', 'space'] as const) {
        for (const name of getAccessibleTableNames(scopeType)) {
          accountedFor.add(name);
        }
      }
      for (const name of getExcludedTableNames()) {
        accountedFor.add(name);
      }

      // Every actual table must be accounted for
      const unaccounted: string[] = [];
      for (const tableName of actualTables) {
        if (!accountedFor.has(tableName)) {
          unaccounted.push(tableName);
        }
      }
      expect(unaccounted).toEqual([]);
    });
  });
});
