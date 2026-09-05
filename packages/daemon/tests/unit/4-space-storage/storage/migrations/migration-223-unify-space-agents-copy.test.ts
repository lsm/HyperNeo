import { describe, expect, test } from 'bun:test';
import type { SettingSource, ThinkingLevel } from '@hyperneo/shared';
import { workerAgentToLongHorizonParams } from '../../../../../src/lib/space/agents/worker-long-horizon-mapper.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigration223 } from '../../../../../src/storage/schema/m223-unify-space-agents-copy.ts';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import {
  createLegacySpaceAgentTables,
  createSpaceAgentSchema,
  insertSpace,
} from '../../../helpers/space-agent-schema.ts';

interface WorkerSeed {
  id: string;
  spaceId: string;
  name: string;
  handle: string | null;
  status: string;
  description: string;
  model: string | null;
  thinkingLevel: string | null;
  provider: string | null;
  customPrompt: string | null;
  systemPrompt: string;
  instructions: string | null;
  tools: string;
  settingSources: string | null;
  modelPool: string | null;
  createdAt: number;
}

function makeOverlayDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createSpaceAgentSchema(db);
  db.exec('DROP INDEX idx_space_agents_handle');
  db.exec(`
    CREATE TABLE space_agent_inbox_messages (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      source_actor_id TEXT NOT NULL,
      source_session_id TEXT,
      message TEXT NOT NULL,
      message_record_json TEXT,
      idempotency_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_attempt_at INTEGER,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'delivered', 'expired', 'failed')),
      delivered_at INTEGER,
      delivered_session_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  return db;
}

function seedWorker(db: BunDatabase, seed: Partial<WorkerSeed> & { id: string; spaceId: string }) {
  const full: WorkerSeed = {
    name: seed.name ?? seed.id,
    handle: seed.handle ?? null,
    status: seed.status ?? 'active',
    description: seed.description ?? '',
    model: seed.model ?? null,
    thinkingLevel: seed.thinkingLevel ?? null,
    provider: seed.provider ?? null,
    customPrompt: seed.customPrompt ?? null,
    systemPrompt: seed.systemPrompt ?? '',
    instructions: seed.instructions ?? null,
    tools: seed.tools ?? '[]',
    settingSources: seed.settingSources ?? null,
    modelPool: seed.modelPool ?? null,
    createdAt: seed.createdAt ?? 100,
    ...seed,
  } as WorkerSeed;
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, description, model,
     thinking_level, provider, custom_prompt, system_prompt, instructions, tools,
     setting_sources, model_pool, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    full.id,
    full.spaceId,
    full.name,
    full.handle,
    full.status,
    full.description,
    full.model,
    full.thinkingLevel,
    full.provider,
    full.customPrompt,
    full.systemPrompt,
    full.instructions,
    full.tools,
    full.settingSources,
    full.modelPool,
    full.createdAt,
    200
  );
  return full;
}

function seedLongHorizonAgent(
  db: BunDatabase,
  row: {
    id: string;
    spaceId: string;
    handle: string;
    displayName: string;
    templateKey?: string | null;
    status?: string;
    instructions?: string;
    updatedAt?: number;
  }
): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, session_id,
       instructions, autonomy_level, model, thinking_level, provider, setting_sources,
       tool_permissions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, '{}', 50, ?)`
  ).run(
    row.id,
    row.spaceId,
    row.handle,
    row.displayName,
    row.templateKey ?? null,
    row.status ?? 'active',
    row.instructions ?? 'Kept instructions',
    row.updatedAt ?? 60
  );
}

function seedNodeExecution(
  db: BunDatabase,
  row: {
    id: string;
    workflowRunId: string;
    workflowNodeId: string;
    agentName: string;
    agentId: string | null;
    status?: string;
    agentSessionId?: string | null;
    data?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO node_executions (
       id, workflow_run_id, workflow_node_id, agent_name, agent_id, agent_session_id,
       status, result, data, created_at, started_at, completed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 10, 11, 12, 13)`
  ).run(
    row.id,
    row.workflowRunId,
    row.workflowNodeId,
    row.agentName,
    row.agentId,
    row.agentSessionId ?? null,
    row.status ?? 'in_progress',
    row.data ?? null
  );
}

function longHorizonRow(db: BunDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM space_long_horizon_agents WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function columnNames(db: BunDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name
  );
}

function tableSql(db: BunDatabase, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  return (row?.sql ?? '').replace(/\s+/g, ' ');
}

function mapperSource(seed: WorkerSeed) {
  const tools =
    seed.tools === '' || seed.tools === '[]' ? [] : (JSON.parse(seed.tools) as string[]);
  return {
    id: seed.id,
    spaceId: seed.spaceId,
    name: seed.name,
    handle: seed.handle,
    status: seed.status,
    description: seed.description,
    model: seed.model,
    thinkingLevel: seed.thinkingLevel as ThinkingLevel | null,
    provider: seed.provider,
    customPrompt: seed.customPrompt,
    instructions: seed.instructions,
    systemPrompt: seed.systemPrompt,
    tools,
    settingSources: seed.settingSources
      ? (JSON.parse(seed.settingSources) as SettingSource[])
      : null,
    modelPool: seed.modelPool ? (JSON.parse(seed.modelPool) as never) : null,
    createdAt: seed.createdAt,
  };
}

function occupiedHandles(db: BunDatabase, spaceId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT handle FROM space_long_horizon_agents WHERE space_id = ? AND status != 'archived'`
    )
    .all(spaceId) as Array<{ handle: string }>;
  return new Set(rows.map((row) => row.handle));
}

describe('migration 223 — full migration chain', () => {
  test('fresh DB records the marker and shapes the unified schema', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    createTables(db);

    expect(
      db.prepare(`SELECT 1 FROM migration_markers WHERE key = 'migration_223'`).get()
    ).toBeDefined();
    expect(columnNames(db, 'space_long_horizon_agents')).toContain('description');
    expect(columnNames(db, 'space_long_horizon_agents')).toContain('model_pool');
    expect(tableSql(db, 'space_long_horizon_agents')).toContain('description TEXT');
    expect(
      db.prepare(`SELECT description, model_pool FROM space_long_horizon_agents LIMIT 1`).get()
    ).toBeNull();
    db.close();
  });
});

describe('migration 223 — copy backfill', () => {
  test('copies every worker row with the mapper field mapping, marker template, and null session/autonomy', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    const seeds = [
      seedWorker(db, {
        id: 'w-full',
        spaceId: 'space-a',
        name: 'Researcher',
        handle: 'researcher',
        status: 'paused',
        description: 'Runs things',
        model: 'm1',
        thinkingLevel: 'think8k',
        provider: 'provider-x',
        customPrompt: 'Custom prompt',
        tools: '["bash","read"]',
        settingSources: '["user","project"]',
        modelPool: '[{"model":"m1","provider":"provider-x","maxConcurrent":2,"weight":1}]',
        createdAt: 111,
      }),
      seedWorker(db, {
        id: 'w-instr',
        spaceId: 'space-a',
        name: 'Inline',
        handle: 'inline',
        instructions: 'Inline prompt',
        systemPrompt: 'Sys prompt',
      }),
      seedWorker(db, {
        id: 'w-sys',
        spaceId: 'space-a',
        name: 'Sys Only',
        handle: 'sys-only',
        systemPrompt: 'Sys prompt',
      }),
      seedWorker(db, {
        id: 'w-archived',
        spaceId: 'space-a',
        name: 'Retired',
        handle: 'retired',
        status: 'archived',
      }),
      seedWorker(db, {
        id: 'w-empty-desc',
        spaceId: 'space-a',
        name: 'Empty Desc',
        handle: 'empty-desc',
        description: '',
      }),
      seedWorker(db, { id: 'w-nullhandle', spaceId: 'space-a', name: 'Planner', handle: null }),
    ];

    runMigration223(db);

    const workerCount = db.prepare(`SELECT COUNT(*) AS count FROM space_agents`).get() as {
      count: number;
    };
    const copiedCount = db
      .prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agents`)
      .get() as { count: number };
    expect(copiedCount.count).toBe(workerCount.count);
    expect(copiedCount.count).toBe(seeds.length);

    for (const seed of seeds) {
      const row = longHorizonRow(db, seed.id);
      expect(row).toBeDefined();
      expect(row?.space_id).toBe(seed.spaceId);
      expect(row?.display_name).toBe(seed.name);
      expect(row?.template_key).toBe('migration.legacy_space_agent');
      expect(row?.session_id).toBeNull();
      expect(row?.autonomy_level).toBeNull();
      expect(row?.created_at).toBe(seed.createdAt);
      expect(typeof row?.updated_at).toBe('number');
    }

    const full = longHorizonRow(db, 'w-full');
    expect(full?.handle).toBe('researcher');
    expect(full?.status).toBe('paused');
    expect(full?.instructions).toBe('Custom prompt');
    expect(full?.model).toBe('m1');
    expect(full?.thinking_level).toBe('think8k');
    expect(full?.provider).toBe('provider-x');
    expect(full?.setting_sources).toBe('["user","project"]');
    expect(full?.tool_permissions_json).toBe('{"tools":["bash","read"]}');
    expect(full?.description).toBe('Runs things');
    expect(full?.model_pool).toBe(
      '[{"model":"m1","provider":"provider-x","maxConcurrent":2,"weight":1}]'
    );

    expect(longHorizonRow(db, 'w-instr')?.instructions).toBe('Inline prompt');
    expect(longHorizonRow(db, 'w-sys')?.instructions).toBe('Sys prompt');
    expect(longHorizonRow(db, 'w-archived')?.status).toBe('archived');
    expect(longHorizonRow(db, 'w-empty-desc')?.description).toBeNull();
    expect(longHorizonRow(db, 'w-empty-desc')?.model_pool).toBeNull();
    expect(longHorizonRow(db, 'w-nullhandle')?.handle).toBe('Planner');
    db.close();
  });

  test('every copied row equals the pure mapper output under the batch reservation protocol', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    seedLongHorizonAgent(db, {
      id: 'lh-research',
      spaceId: 'space-a',
      handle: 'research',
      displayName: 'Research',
      templateKey: 'research.default',
    });
    const seeds = [
      seedWorker(db, {
        id: 'w-a',
        spaceId: 'space-a',
        name: 'Research',
        handle: 'research',
        createdAt: 100,
      }),
      seedWorker(db, {
        id: 'w-b',
        spaceId: 'space-a',
        name: 'Coder',
        handle: 'coder',
        createdAt: 101,
      }),
      seedWorker(db, { id: 'w-c', spaceId: 'space-a', name: 'QA', handle: 'qa', createdAt: 102 }),
    ];

    const occupied = occupiedHandles(db, 'space-a');

    runMigration223(db);

    const ordered = [...seeds].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    );
    for (const seed of ordered) {
      const params = workerAgentToLongHorizonParams(mapperSource(seed), {
        occupiedHandles: occupied,
        now: 12345,
      });
      occupied.add(params.handle);
      const row = longHorizonRow(db, seed.id);
      expect(row?.handle).toBe(params.handle);
      expect(row?.display_name).toBe(params.displayName);
      expect(row?.status).toBe(params.status);
      expect(row?.instructions).toBe(params.instructions);
      expect(row?.model).toBe(params.model);
      expect(row?.thinking_level).toBe(params.thinkingLevel);
      expect(row?.provider).toBe(params.provider);
      expect(row?.setting_sources).toBe(
        params.settingSources ? JSON.stringify(params.settingSources) : null
      );
      expect(row?.tool_permissions_json).toBe(JSON.stringify(params.toolPermissions));
      expect(row?.description).toBe(params.description ?? null);
      expect(row?.model_pool).toBe(params.modelPool ? JSON.stringify(params.modelPool) : null);
    }
    db.close();
  });

  test('unreferenced workers are copied too — the m155 delta', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    db.exec(`
      CREATE TABLE space_agent_goal_assignments (
        space_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, goal_id)
      )
    `);
    seedWorker(db, { id: 'w-referenced', spaceId: 'space-a', name: 'Referenced', handle: 'ref' });
    seedWorker(db, { id: 'w-orphan', spaceId: 'space-a', name: 'Orphan', handle: 'orphan' });
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES ('space-a', 'w-referenced', 'goal-1', 1)`
    ).run();

    runMigration223(db);

    expect(longHorizonRow(db, 'w-referenced')).toBeDefined();
    expect(longHorizonRow(db, 'w-orphan')).toBeDefined();
    db.close();
  });
});

describe('migration 223 — handle collisions', () => {
  test('research preset vs research.default template suffixes deterministically', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    seedLongHorizonAgent(db, {
      id: 'lh-research',
      spaceId: 'space-a',
      handle: 'research',
      displayName: 'Research',
      templateKey: 'research.default',
    });
    seedWorker(db, {
      id: 'ag-research',
      spaceId: 'space-a',
      name: 'Research',
      handle: 'research',
    });

    runMigration223(db);

    expect(longHorizonRow(db, 'ag-research')?.handle).toBe('research-ag-research');
    expect(longHorizonRow(db, 'lh-research')?.handle).toBe('research');
    db.close();
  });

  test('collisions against the coordinator row dedupe and leave it untouched', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    const repo = new SpaceLongHorizonAgentRepository(db);
    repo.ensureCoordinator('space-a');
    seedWorker(db, {
      id: 'w-coordinator',
      spaceId: 'space-a',
      name: 'Coordinator',
      handle: 'coordinator',
    });

    runMigration223(db);

    expect(longHorizonRow(db, 'w-coordinator')?.handle).toBe('coordinator-w-coordinator');
    const coordinator = repo.getCoordinator('space-a');
    expect(coordinator?.id).toBe('space-lh-agent:coordinator:space-a');
    expect(coordinator?.status).toBe('active');
    db.close();
  });

  test('same-handle workers resolve in creation order with -<agentId> suffixes', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    seedWorker(db, {
      id: 'w-first',
      spaceId: 'space-a',
      name: 'Planner',
      handle: null,
      createdAt: 100,
    });
    seedWorker(db, {
      id: 'w-second',
      spaceId: 'space-a',
      name: 'Planner',
      handle: null,
      createdAt: 101,
    });

    runMigration223(db);

    expect(longHorizonRow(db, 'w-first')?.handle).toBe('Planner');
    expect(longHorizonRow(db, 'w-second')?.handle).toBe('Planner-w-second');
    db.close();
  });

  test('handles keep re-suffixed when the base and first suffix are both occupied', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    seedLongHorizonAgent(db, {
      id: 'lh-base',
      spaceId: 'space-a',
      handle: 'researcher',
      displayName: 'Base Holder',
    });
    seedLongHorizonAgent(db, {
      id: 'lh-suffix',
      spaceId: 'space-a',
      handle: 'researcher-w-1',
      displayName: 'Suffix Holder',
    });
    seedWorker(db, { id: 'w-1', spaceId: 'space-a', name: 'Researcher', handle: 'researcher' });

    runMigration223(db);

    expect(longHorizonRow(db, 'w-1')?.handle).toBe('researcher-w-1-w-1');
    db.close();
  });

  test('suffix chains resolve past ten occupied levels without aborting', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    for (let level = 0; level < 10; level += 1) {
      seedLongHorizonAgent(db, {
        id: `lh-level-${level}`,
        spaceId: 'space-a',
        handle: `research${'-w-1'.repeat(level)}`,
        displayName: `Level ${level}`,
      });
    }
    seedWorker(db, { id: 'w-1', spaceId: 'space-a', name: 'Research', handle: 'research' });

    runMigration223(db);

    expect(longHorizonRow(db, 'w-1')?.handle).toBe(`research${'-w-1'.repeat(10)}`);
    db.close();
  });

  test('archived long-horizon holders do not reserve handles and cross-space handles never collide', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    insertSpace(db, 'space-b');
    seedLongHorizonAgent(db, {
      id: 'lh-arch',
      spaceId: 'space-a',
      handle: 'scribe',
      displayName: 'Archived Holder',
      status: 'archived',
    });
    seedLongHorizonAgent(db, {
      id: 'lh-other',
      spaceId: 'space-b',
      handle: 'scribe',
      displayName: 'Other',
    });
    seedWorker(db, { id: 'w-archspace', spaceId: 'space-a', name: 'Scribe', handle: 'scribe' });
    seedWorker(db, { id: 'w-otherspace', spaceId: 'space-b', name: 'Scribe', handle: 'scribe' });

    runMigration223(db);

    expect(longHorizonRow(db, 'w-archspace')?.handle).toBe('scribe');
    expect(longHorizonRow(db, 'w-otherspace')?.handle).toBe('scribe-w-otherspace');
    db.close();
  });

  test('collision outcomes are deterministic across identical fixture runs', () => {
    const build = () => {
      const db = makeOverlayDb();
      insertSpace(db, 'space-a');
      seedLongHorizonAgent(db, {
        id: 'lh-research',
        spaceId: 'space-a',
        handle: 'research',
        displayName: 'Research',
        templateKey: 'research.default',
      });
      seedWorker(db, {
        id: 'w-x',
        spaceId: 'space-a',
        name: 'Research',
        handle: 'research',
        createdAt: 100,
      });
      seedWorker(db, {
        id: 'w-y',
        spaceId: 'space-a',
        name: 'Research',
        handle: 'research',
        createdAt: 101,
      });
      runMigration223(db);
      const handles = db
        .prepare(`SELECT id, handle FROM space_long_horizon_agents ORDER BY id`)
        .all() as Array<{ id: string; handle: string }>;
      db.close();
      return handles;
    };

    expect(build()).toEqual(build());
  });
});

describe('migration 223 — idempotency and partial retry', () => {
  test('a second run copies nothing new and leaves copied rows untouched', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    seedWorker(db, { id: 'w-1', spaceId: 'space-a', name: 'Coder', handle: 'coder' });

    runMigration223(db);
    const first = longHorizonRow(db, 'w-1');
    const firstStamp = first?.updated_at as number;

    runMigration223(db);

    const second = longHorizonRow(db, 'w-1');
    expect(second?.updated_at).toBe(firstStamp);
    expect(second?.handle).toBe(first?.handle);
    const count = db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agents`).get() as {
      count: number;
    };
    expect(count.count).toBe(1);
    db.close();
  });

  test('m155-prebackfilled rows are not duplicated and partial application completes safely', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    seedWorker(db, {
      id: 'w-partial',
      spaceId: 'space-a',
      name: 'Partial',
      handle: 'partial',
      description: 'Legacy description',
      modelPool: '[{"model":"m9","provider":"p","maxConcurrent":1,"weight":1}]',
    });
    db.exec(`
      INSERT INTO space_long_horizon_agents (
        id, space_id, handle, display_name, template_key, status, session_id,
        instructions, autonomy_level, model, thinking_level, provider, setting_sources,
        tool_permissions_json, created_at, updated_at
      ) VALUES (
        'w-partial', 'space-a', 'partial', 'Partial', 'migration.legacy_space_agent', 'active', NULL,
        'Earlier copy', NULL, NULL, NULL, NULL, NULL, '{}', 100, 100
      )
    `);
    seedWorker(db, {
      id: 'w-remaining',
      spaceId: 'space-a',
      name: 'Remaining',
      handle: 'remaining',
    });

    runMigration223(db);

    expect(longHorizonRow(db, 'w-partial')?.instructions).toBe('Earlier copy');
    expect(longHorizonRow(db, 'w-partial')?.updated_at).toBe(100);
    expect(longHorizonRow(db, 'w-partial')?.description).toBe('Legacy description');
    expect(longHorizonRow(db, 'w-partial')?.model_pool).toBe(
      '[{"model":"m9","provider":"p","maxConcurrent":1,"weight":1}]'
    );
    expect(longHorizonRow(db, 'w-remaining')?.instructions).toBe('');
    const count = db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agents`).get() as {
      count: number;
    };
    expect(count.count).toBe(2);
    db.close();
  });
});

describe('migration 223 — reference resolution pins', () => {
  test('workflow node agents, node_executions, promptProvenance, and inbox targets resolve in the unified table', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf-1', 'space-a', 'WF', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
       VALUES ('node-1', 'wf-1', 'Node', ?, 1, 1)`
    ).run(JSON.stringify({ agents: [{ agentId: 'w-coder', name: 'Coder' }] }));
    seedWorker(db, { id: 'w-coder', spaceId: 'space-a', name: 'Coder', handle: 'coder' });
    seedNodeExecution(db, {
      id: 'ne-1',
      workflowRunId: 'wf-1',
      workflowNodeId: 'node-1',
      agentName: 'coder',
      agentId: 'w-coder',
    });
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
       VALUES ('sess-1', 'Coder', '/tmp', '1', '1', 'active', '{}', ?, 0, 'worker', '{}')`
    ).run(
      JSON.stringify({
        promptProvenance: { agentId: 'w-coder', agentName: 'coder', nodeId: 'node-1' },
      })
    );
    db.prepare(
      `INSERT INTO space_agent_inbox_messages (
         id, space_id, target_agent_id, source_actor_id, message, expires_at, created_at
       ) VALUES ('inbox-1', 'space-a', 'w-coder', 'agent:coordinator:space-a', 'wake up', 999, 1)`
    ).run();

    runMigration223(db);

    const unresolvedNodeAgents = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM space_workflow_nodes node,
              json_each(json_extract(node.config, '$.agents')) agent
         LEFT JOIN space_long_horizon_agents resolved
           ON resolved.id = json_extract(agent.value, '$.agentId')
         WHERE node.config IS NOT NULL
           AND json_extract(node.config, '$.agents') IS NOT NULL
           AND resolved.id IS NULL`
      )
      .get() as { count: number };
    expect(unresolvedNodeAgents.count).toBe(0);

    const unresolvedExecutions = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM node_executions execution
         LEFT JOIN space_long_horizon_agents resolved ON resolved.id = execution.agent_id
         WHERE execution.agent_id IS NOT NULL AND resolved.id IS NULL`
      )
      .get() as { count: number };
    expect(unresolvedExecutions.count).toBe(0);

    const unresolvedSessions = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions session
         LEFT JOIN space_long_horizon_agents resolved
           ON resolved.id = json_extract(session.metadata, '$.promptProvenance.agentId')
         WHERE json_extract(session.metadata, '$.promptProvenance.agentId') IS NOT NULL
           AND resolved.id IS NULL`
      )
      .get() as { count: number };
    expect(unresolvedSessions.count).toBe(0);

    const unresolvedInbox = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM space_agent_inbox_messages message
         LEFT JOIN space_long_horizon_agents resolved ON resolved.id = message.target_agent_id
         WHERE resolved.id IS NULL`
      )
      .get() as { count: number };
    expect(unresolvedInbox.count).toBe(0);

    const workers = db.prepare(`SELECT COUNT(*) AS count FROM space_agents`).get() as {
      count: number;
    };
    expect(workers.count).toBe(1);
    db.close();
  });

  test('the pending marker reapplies over a post-m222 database via runMigrations', () => {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_223'`).run();
    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_232'`).run();
    createLegacySpaceAgentTables(db);
    db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES ('sp-1', 'sp-1', '/tmp/sp-1', 'S', 1, 1)`
    );
    db.exec(
      `INSERT INTO space_agents (id, space_id, name, handle, created_at, updated_at)
       VALUES ('w-legacy', 'sp-1', 'Coder', 'coder', 10, 10)`
    );

    runMigrations(db, () => {});

    expect(longHorizonRow(db, 'w-legacy')?.template_key).toBe('migration.legacy_space_agent');
    expect(longHorizonRow(db, 'w-legacy')?.handle).toBe('coder');
    expect(
      db.prepare(`SELECT 1 FROM migration_markers WHERE key = 'migration_223'`).get()
    ).toBeDefined();
    db.close();
  });

  test('a cross-space same-id row cannot satisfy the copy check and aborts with a diagnostic', () => {
    const db = makeOverlayDb();
    insertSpace(db, 'space-a');
    insertSpace(db, 'space-b');
    seedWorker(db, { id: 'w-cross', spaceId: 'space-a', name: 'Coder', handle: 'coder' });
    seedLongHorizonAgent(db, {
      id: 'w-cross',
      spaceId: 'space-b',
      handle: 'holder',
      displayName: 'Other Space Holder',
    });

    expect(() => runMigration223(db)).toThrow(/cross-space/i);
    expect(() => runMigration223(db)).toThrow(/w-cross/);
    expect(longHorizonRow(db, 'w-cross')?.space_id).toBe('space-b');
    db.close();
  });
});
