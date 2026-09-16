/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store.ts';
import {
  type ActionDefinition,
  createActionRegistry,
} from '../../../../src/lib/space/actions/registry.ts';
import { createSpaceRegistryEntries } from '../../../../src/lib/space/actions/registry-space.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/tasks/task-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import {
  EXTERNAL_EVENT_TOOL_SCHEMAS,
  INACTIVITY_TOOL_SCHEMAS,
} from '../../../../src/lib/space/actions/space-agent-schemas.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/actions/space-handlers.ts';
import { DEFAULT_INACTIVITY_THRESHOLD_MS } from '../../../../src/lib/external-events/inactivity-operations.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../../../../src/lib/space/tools/tool-admission-gates.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import type { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../../src/storage/repositories/space-agent-inactivity-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-registry-part-c-test';
const LHA_ID = 'lha-1';

const stubTaskAgentManager = {
  injectSubSessionMessage: async () => 'sdk-message-stub',
} as unknown as TaskAgentManager;

interface PartCCtx {
  db: BunDatabase;
  config: SpaceAgentToolsConfig;
}

function makeCtx(overrides: Partial<SpaceAgentToolsConfig> = {}): PartCCtx {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
  `);
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/workspace', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, SPACE_ID, SPACE_ID, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO space_long_horizon_agents (id, space_id, handle, display_name, created_at, updated_at)
     VALUES (?, ?, 'sentinel', 'Sentinel', ?, ?)`
  ).run(LHA_ID, SPACE_ID, Date.now(), Date.now());

  const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceManager = new SpaceManager(db);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const runtime = new SpaceRuntime({
    db,
    spaceManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    longHorizonAgentRepo,
  });
  const config: SpaceAgentToolsConfig = {
    spaceId: SPACE_ID,
    db,
    runtime,
    workflowManager,
    taskRepo,
    nodeExecutionRepo,
    workflowRunRepo,
    taskManager: new SpaceTaskManager(db, SPACE_ID),
    taskAgentManager: stubTaskAgentManager,
    scheduleService: new ScheduleService({
      db,
      scheduleRepo: new TaskScheduleRepository(db),
      jobQueue: new JobQueueRepository(db),
      spaceRepo: new SpaceRepository(db),
    }),
    myAgentId: LHA_ID,
    inactivityConfigRepo: new SpaceAgentInactivityConfigRepository(db),
    inactivityClaimRepo: new SpaceAgentInactivityClaimRepository(db),
    ...overrides,
  };
  return { db, config };
}

const stubExternalEventStore = (record?: { eventId: string }) =>
  ({
    getById: (eventId: string) =>
      record && eventId === record.eventId
        ? { event: { id: eventId, spaceId: SPACE_ID }, state: 'delivered' }
        : undefined,
  }) as unknown as ExternalEventStore;

const EXPECTED_BASE: Array<[string, string, string]> = [
  ['list_agents', 'agents', 'read'],
  ['get_agent', 'agents', 'read'],
  ['create_agent', 'agents', 'mutate'],
  ['create_agent_from_template', 'agents', 'mutate'],
  ['create_agent_template', 'agents', 'mutate'],
  ['update_agent_template', 'agents', 'mutate'],
  ['list_agent_templates', 'agents', 'read'],
  ['delete_agent_template', 'agents', 'destructive'],
  ['update_agent', 'agents', 'mutate'],
  ['pause_agent', 'agents', 'mutate'],
  ['archive_agent', 'agents', 'mutate'],
  ['assign_agent_to_goal', 'agents', 'mutate'],
  ['unassign_agent_from_goal', 'agents', 'mutate'],
  ['assign_agent_to_forge_scope', 'agents', 'mutate'],
  ['unassign_agent_from_forge_scope', 'agents', 'mutate'],
  ['create_agent_reminder', 'agents', 'mutate'],
  ['list_agent_reminders', 'agents', 'read'],
  ['subscribe_agent_event', 'agents', 'mutate'],
  ['unsubscribe_agent_event', 'agents', 'mutate'],
  ['list_agent_event_subscriptions', 'agents', 'read'],
  ['list_workflows', 'workflows', 'read'],
  ['get_workflow_run', 'workflows', 'read'],
  ['change_plan', 'workflows', 'destructive'],
  ['get_workflow_detail', 'workflows', 'read'],
  ['suggest_workflow', 'workflows', 'read'],
  ['list_tasks', 'tasks', 'read'],
  ['create_standalone_task', 'tasks', 'mutate'],
  ['update_task', 'tasks', 'mutate'],
  ['reassign_task', 'tasks', 'mutate'],
  ['send_message_to_task', 'tasks', 'mutate'],
  ['approve_task', 'tasks', 'mutate'],
  ['approve_pending_completion', 'tasks', 'human_only'],
];

const EXPECTED_PART_C: Array<[string, string, string]> = [
  ['get_external_event', 'external_events', 'read'],
  ['inactivity_config_get', 'inactivity', 'read'],
  ['inactivity_config_set_enabled', 'inactivity', 'mutate'],
  ['inactivity_config_set', 'inactivity', 'mutate'],
  ['inactivity_run_now', 'inactivity', 'mutate'],
];

const SCHEMA_GROUPS: Record<string, ActionDefinition['paramsSchema']> = {
  ...EXTERNAL_EVENT_TOOL_SCHEMAS,
  ...INACTIVITY_TOOL_SCHEMAS,
};

const PART_C_FAMILIES = new Set(['external_events', 'inactivity']);

function withExternalEventStore(overrides: Partial<SpaceAgentToolsConfig> = {}) {
  return makeCtx({
    externalEventStore: stubExternalEventStore({ eventId: 'evt-1' }),
    ...overrides,
  });
}

describe('createSpaceRegistryEntries — composition', () => {
  test('appends the authored part C families after the sessions/workflows entries', () => {
    const ctx = withExternalEventStore({ inactivityRunNow: async () => {} });
    try {
      const rows = createSpaceRegistryEntries(ctx.config).map((entry) => [
        entry.name,
        entry.family,
        entry.safetyClass,
      ]);
      expect(rows.slice(0, -EXPECTED_PART_C.length)).toEqual(EXPECTED_BASE);
      expect(rows.slice(-EXPECTED_PART_C.length)).toEqual(EXPECTED_PART_C);
      for (const entry of createSpaceRegistryEntries(ctx.config)) {
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.paramsDoc.length).toBeGreaterThan(0);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('shares the schema objects with the typed server — one parse path', () => {
    const ctx = withExternalEventStore({ inactivityRunNow: async () => {} });
    try {
      const partC = createSpaceRegistryEntries(ctx.config).filter((entry) =>
        PART_C_FAMILIES.has(entry.family)
      );
      expect(partC).toHaveLength(EXPECTED_PART_C.length);
      for (const entry of partC) {
        expect(entry.paramsSchema).toBe(SCHEMA_GROUPS[entry.name]);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('composes into a valid action registry', () => {
    const ctx = withExternalEventStore({ inactivityRunNow: async () => {} });
    try {
      const registry = createActionRegistry(createSpaceRegistryEntries(ctx.config));
      expect(registry.entries).toHaveLength(EXPECTED_BASE.length + EXPECTED_PART_C.length);
      expect(registry.get('get_external_event')?.family).toBe('external_events');
    } finally {
      ctx.db.close();
    }
  });

  test('the typed path gates none of part C', () => {
    const ctx = withExternalEventStore({ inactivityRunNow: async () => {} });
    try {
      const partC = createSpaceRegistryEntries(ctx.config).filter((entry) =>
        PART_C_FAMILIES.has(entry.family)
      );
      expect(partC.length).toBeGreaterThan(0);
      for (const entry of partC) {
        expect(entry.autonomyRequirement).toBeUndefined();
      }
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — conditional entries', () => {
  test('omits get_external_event when externalEventStore is absent', () => {
    const ctx = makeCtx({ inactivityRunNow: async () => {} });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.map((entry) => entry.name)).not.toContain('get_external_event');
      expect(entries).toHaveLength(EXPECTED_BASE.length + EXPECTED_PART_C.length - 1);
    } finally {
      ctx.db.close();
    }
  });

  test('omits every inactivity entry when inactivityConfigRepo is absent', () => {
    const ctx = withExternalEventStore({
      inactivityConfigRepo: undefined,
      inactivityRunNow: async () => {},
    });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.filter((entry) => entry.family === 'inactivity')).toEqual([]);
      expect(entries).toHaveLength(EXPECTED_BASE.length + EXPECTED_PART_C.length - 4);
    } finally {
      ctx.db.close();
    }
  });

  test('omits inactivity_run_now alone when only inactivityRunNow is absent', () => {
    const ctx = withExternalEventStore();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.map((entry) => entry.name)).not.toContain('inactivity_run_now');
      expect(entries).toHaveLength(EXPECTED_BASE.length + EXPECTED_PART_C.length - 1);
    } finally {
      ctx.db.close();
    }
  });
});

async function textPayload(result: unknown): Promise<Record<string, unknown>> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('createSpaceRegistryEntries — get_external_event wiring', () => {
  test('returns the record for a known event and not-found for unknown ids', async () => {
    const ctx = withExternalEventStore();
    try {
      const entry = createSpaceRegistryEntries(ctx.config).find(
        (candidate) => candidate.name === 'get_external_event'
      );
      if (!entry) throw new Error('get_external_event entry missing');

      const hit = (await textPayload(await entry.handler({ eventId: 'evt-1' }))) as {
        success: boolean;
        event: { id: string };
        state: string;
      };
      expect(hit.success).toBe(true);
      expect(hit.event.id).toBe('evt-1');
      expect(hit.state).toBe('delivered');

      const miss = (await textPayload(await entry.handler({ eventId: 'evt-other' }))) as {
        success: boolean;
        error?: string;
      };
      expect(miss.success).toBe(false);
      expect(miss.error).toContain('evt-other');
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — inactivity wiring', () => {
  test('rejects inactivity handlers without an agent identity', async () => {
    const ctx = withExternalEventStore();
    try {
      const byName = new Map(
        createSpaceRegistryEntries({ ...ctx.config, myAgentId: undefined }).map((entry) => [
          entry.name,
          entry,
        ])
      );
      await expect(byName.get('inactivity_config_get')!.handler({})).rejects.toThrow(
        'No agent identity available for inactivity config'
      );
      await expect(
        byName.get('inactivity_config_set_enabled')!.handler({ enabled: true })
      ).rejects.toThrow('No agent identity available for inactivity config');
    } finally {
      ctx.db.close();
    }
  });

  test('mirrors the typed surface: get, set_enabled default threshold, set, run_now', async () => {
    const runs: Array<[string, string]> = [];
    const ctx = withExternalEventStore({
      inactivityRunNow: async (spaceId, agentId) => {
        runs.push([spaceId, agentId]);
      },
    });
    try {
      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );

      const initial = (await textPayload(
        await byName.get('inactivity_config_get')!.handler({})
      )) as { config: { thresholdMs: number | null } | null; degraded: boolean };
      expect(initial.config).toBeNull();
      expect(initial.degraded).toBe(false);

      const enabled = (await textPayload(
        await byName.get('inactivity_config_set_enabled')!.handler({ enabled: true })
      )) as { ok: boolean; enabled: boolean };
      expect(enabled).toEqual({ ok: true, enabled: true });

      const afterEnable = (await textPayload(
        await byName.get('inactivity_config_get')!.handler({})
      )) as { config: { enabled: boolean; thresholdMs: number | null } };
      expect(afterEnable.config.enabled).toBe(true);
      expect(afterEnable.config.thresholdMs).toBe(DEFAULT_INACTIVITY_THRESHOLD_MS);

      const adjusted = (await textPayload(
        await byName.get('inactivity_config_set')!.handler({ threshold_ms: 123_456, prompt: 'nag' })
      )) as { ok: boolean };
      expect(adjusted).toEqual({ ok: true });

      const afterSet = (await textPayload(
        await byName.get('inactivity_config_get')!.handler({})
      )) as { config: { thresholdMs: number | null; prompt: string | null } };
      expect(afterSet.config.thresholdMs).toBe(123_456);
      expect(afterSet.config.prompt).toBe('nag');

      const ranNow = (await textPayload(await byName.get('inactivity_run_now')!.handler({}))) as {
        ok: boolean;
      };
      expect(ranNow).toEqual({ ok: true });
      expect(runs).toEqual([[SPACE_ID, LHA_ID]]);
    } finally {
      ctx.db.close();
    }
  });
});
