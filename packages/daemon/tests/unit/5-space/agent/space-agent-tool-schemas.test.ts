import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS,
  SPACE_AGENT_TOOL_SCHEMAS,
  SPACE_FORGE_TOOL_SCHEMAS,
  SPACE_GOAL_TOOL_SCHEMAS,
  type SpaceAgentLifecycleToolName,
  type SpaceAgentToolName,
  type SpaceForgeToolName,
  type SpaceGoalToolName,
} from '../../../../src/lib/space/tools/space-agent-tool-schemas.ts';

const BASE_TOOL_NAMES: SpaceAgentToolName[] = [
  'list_sessions',
  'get_session_detail',
  'get_session_messages',
  'send_session_message',
  'update_session_state',
  'interrupt_session',
  'list_workflows',
  'get_workflow_run',
  'change_plan',
  'get_workflow_detail',
  'suggest_workflow',
  'list_tasks',
  'create_standalone_task',
  'get_task_detail',
  'update_task',
  'retry_task',
  'cancel_task',
  'reassign_task',
  'publish_task',
  'archive_task',
  'send_message_to_task',
  'list_task_members',
  'approve_task',
  'approve_pending_completion',
];

describe('SPACE_AGENT_TOOL_SCHEMAS', () => {
  test('contains exactly the 24 base tools', () => {
    expect(Object.keys(SPACE_AGENT_TOOL_SCHEMAS).sort()).toEqual([...BASE_TOOL_NAMES].sort());
    expect(Object.keys(SPACE_AGENT_TOOL_SCHEMAS)).toHaveLength(24);
  });

  test('each schema value is a zod object schema with safeParse and a shape', () => {
    for (const schema of Object.values(SPACE_AGENT_TOOL_SCHEMAS)) {
      expect(typeof schema.safeParse).toBe('function');
      expect(schema.shape).toBeDefined();
    }
  });
});

interface SafeParsePin {
  tool: SpaceAgentToolName;
  accepts: Array<{ input: unknown; data?: Record<string, unknown> }>;
  rejects: unknown[];
}

const SAFE_PARSE_PINS: SafeParsePin[] = [
  {
    tool: 'list_sessions',
    accepts: [
      { input: {}, data: { limit: 50, offset: 0 } },
      {
        input: { status: 'idle', type: 'worker', limit: 10, offset: 5 },
        data: { status: 'idle', type: 'worker', limit: 10, offset: 5 },
      },
    ],
    rejects: [{ status: 'paused' }, { limit: 101 }, { limit: 0 }, { offset: -1 }],
  },
  {
    tool: 'get_session_detail',
    accepts: [{ input: { session_id: 's1' }, data: { session_id: 's1' } }],
    rejects: [{}, { session_id: 5 }],
  },
  {
    tool: 'get_session_messages',
    accepts: [
      { input: { session_id: 's1' }, data: { session_id: 's1', limit: 20 } },
      {
        input: { session_id: 's1', limit: 100, before: '2026-01-01' },
        data: { session_id: 's1', limit: 100, before: '2026-01-01' },
      },
    ],
    rejects: [{}, { session_id: 's1', limit: 101 }],
  },
  {
    tool: 'send_session_message',
    accepts: [
      {
        input: { session_id: 's1', message: 'hello' },
        data: { session_id: 's1', message: 'hello' },
      },
      {
        input: { session_id: 's1', message: 'hello', answer_question: true },
        data: { session_id: 's1', message: 'hello', answer_question: true },
      },
    ],
    rejects: [{ session_id: 's1', message: '' }, { session_id: 's1' }],
  },
  {
    tool: 'update_session_state',
    accepts: [
      {
        input: { session_id: 's1', processing_state: 'running' },
        data: { session_id: 's1', processing_state: 'running' },
      },
      {
        input: { session_id: 's1', processing_state: 'idle', clear_pending_question: true },
        data: { session_id: 's1', processing_state: 'idle', clear_pending_question: true },
      },
    ],
    rejects: [{ session_id: 's1', processing_state: 'archived' }, { processing_state: 'idle' }],
  },
  {
    tool: 'interrupt_session',
    accepts: [
      {
        input: { session_id: 's1', reason: 'stuck' },
        data: { session_id: 's1', reason: 'stuck' },
      },
      { input: { session_id: 's1' }, data: { session_id: 's1' } },
    ],
    rejects: [{ reason: 'stuck' }],
  },
  {
    tool: 'list_workflows',
    accepts: [{ input: {}, data: {} }],
    rejects: ['not-an-object'],
  },
  {
    tool: 'get_workflow_run',
    accepts: [{ input: { run_id: 'r1' }, data: { run_id: 'r1' } }],
    rejects: [{}],
  },
  {
    tool: 'change_plan',
    accepts: [
      { input: { run_id: 'r1', description: 'd' }, data: { run_id: 'r1', description: 'd' } },
      {
        input: { run_id: 'r1', workflow_handle: 'coding-with-qa' },
        data: { run_id: 'r1', workflow_handle: 'coding-with-qa' },
      },
    ],
    rejects: [{ description: 'd' }],
  },
  {
    tool: 'get_workflow_detail',
    accepts: [
      { input: {}, data: {} },
      { input: { workflow_handle: 'wf' }, data: { workflow_handle: 'wf' } },
    ],
    rejects: [{ workflow_id: 3 }],
  },
  {
    tool: 'suggest_workflow',
    accepts: [
      {
        input: { description: 'ship a feature' },
        data: { description: 'ship a feature' },
      },
    ],
    rejects: [{}],
  },
  {
    tool: 'list_tasks',
    accepts: [
      { input: {}, data: { limit: 50, offset: 0, compact: false } },
      {
        input: { status: 'in_progress', workflow_run_id: 'r1', search: 'auth', compact: true },
        data: {
          status: 'in_progress',
          workflow_run_id: 'r1',
          search: 'auth',
          compact: true,
          limit: 50,
          offset: 0,
        },
      },
    ],
    rejects: [{ status: 'rate_limited' }, { status: 'stopped' }, { limit: -1 }],
  },
  {
    tool: 'create_standalone_task',
    accepts: [
      { input: { title: 'T', description: 'D' }, data: { title: 'T', description: 'D' } },
      {
        input: {
          title: 'T',
          description: 'D',
          priority: 'urgent',
          custom_agent_id: 'agent-1',
          workflow_handle: 'coding-with-qa',
          depends_on: ['t1', 't2'],
          draft: true,
          workspace: 'ws',
        },
        data: {
          title: 'T',
          description: 'D',
          priority: 'urgent',
          custom_agent_id: 'agent-1',
          workflow_handle: 'coding-with-qa',
          depends_on: ['t1', 't2'],
          draft: true,
          workspace: 'ws',
        },
      },
    ],
    rejects: [{ description: 'D' }, { title: 'T' }],
  },
  {
    tool: 'get_task_detail',
    accepts: [
      { input: {}, data: {} },
      { input: { task_number: 5 }, data: { task_number: 5 } },
      { input: { task_id: 'u1' }, data: { task_id: 'u1' } },
    ],
    rejects: [{ task_number: 'five' }],
  },
  {
    tool: 'update_task',
    accepts: [
      {
        input: { task_id: 't1', status: 'rate_limited' },
        data: { task_id: 't1', status: 'rate_limited' },
      },
      {
        input: { task_id: 't1', title: 'New', depends_on: [] },
        data: { task_id: 't1', title: 'New', depends_on: [] },
      },
    ],
    rejects: [{ task_id: 't1', title: '' }, { task_id: 't1', status: 'paused' }, {}],
  },
  {
    tool: 'retry_task',
    accepts: [
      {
        input: { task_id: 't1', description: 'retry harder' },
        data: { task_id: 't1', description: 'retry harder' },
      },
      { input: { task_id: 't1' }, data: { task_id: 't1' } },
    ],
    rejects: [{}],
  },
  {
    tool: 'cancel_task',
    accepts: [
      {
        input: { task_id: 't1', cancel_workflow_run: true },
        data: { task_id: 't1', cancel_workflow_run: true },
      },
      { input: { task_id: 't1' }, data: { task_id: 't1' } },
    ],
    rejects: [{}],
  },
  {
    tool: 'reassign_task',
    accepts: [
      {
        input: { task_id: 't1', custom_agent_id: null, assigned_agent: 'coder' },
        data: { task_id: 't1', custom_agent_id: null, assigned_agent: 'coder' },
      },
      { input: { task_id: 't1' }, data: { task_id: 't1' } },
    ],
    rejects: [{ task_id: 't1', assigned_agent: 'qa' }],
  },
  {
    tool: 'publish_task',
    accepts: [{ input: { task_id: 't1' }, data: { task_id: 't1' } }],
    rejects: [{}],
  },
  {
    tool: 'archive_task',
    accepts: [{ input: { task_id: 't1' }, data: { task_id: 't1' } }],
    rejects: [{}],
  },
  {
    tool: 'send_message_to_task',
    accepts: [
      { input: { message: 'hello', task_number: 37 }, data: { message: 'hello', task_number: 37 } },
      {
        input: { message: 'hello', task_id: 't1', node_id: 'coder', target: '@reviewer' },
        data: { message: 'hello', task_id: 't1', node_id: 'coder', target: '@reviewer' },
      },
    ],
    rejects: [{}, { message: 'hi', task_number: 0 }],
  },
  {
    tool: 'list_task_members',
    accepts: [{ input: { task_id: 't1' }, data: { task_id: 't1' } }],
    rejects: [{}],
  },
  {
    tool: 'approve_task',
    accepts: [
      { input: { task_id: 't1', reason: 'ok' }, data: { task_id: 't1', reason: 'ok' } },
      { input: { task_id: 't1' }, data: { task_id: 't1' } },
    ],
    rejects: [{}],
  },
  {
    tool: 'approve_pending_completion',
    accepts: [
      {
        input: { task_id: 't1', approved: true },
        data: { task_id: 't1', approved: true },
      },
      {
        input: { task_id: 't1', approved: false, reason: null },
        data: { task_id: 't1', approved: false, reason: null },
      },
    ],
    rejects: [{ task_id: 't1' }, { task_id: 't1', approved: 'yes' }],
  },
];

describe('SPACE_AGENT_TOOL_SCHEMAS safeParse pins', () => {
  test('pins cover every base tool', () => {
    expect(SAFE_PARSE_PINS.map((pin) => pin.tool).sort()).toEqual([...BASE_TOOL_NAMES].sort());
  });

  for (const pin of SAFE_PARSE_PINS) {
    const schema = SPACE_AGENT_TOOL_SCHEMAS[pin.tool] as z.ZodType;
    describe(pin.tool, () => {
      for (const { input, data } of pin.accepts) {
        test(`accepts ${JSON.stringify(input)}`, () => {
          const result = schema.safeParse(input);
          expect(result.success).toBe(true);
          if (data && result.success) {
            expect(result.data).toEqual(data);
          }
        });
      }
      for (const input of pin.rejects) {
        test(`rejects ${JSON.stringify(input)}`, () => {
          expect(schema.safeParse(input).success).toBe(false);
        });
      }
    });
  }
});

const LIFECYCLE_TOOL_NAMES: SpaceAgentLifecycleToolName[] = [
  'list_agents',
  'get_agent',
  'create_agent',
  'create_agent_from_template',
  'list_agent_templates',
  'update_agent',
  'pause_agent',
  'archive_agent',
  'assign_agent_to_goal',
  'unassign_agent_from_goal',
  'assign_agent_to_forge_scope',
  'unassign_agent_from_forge_scope',
  'create_agent_reminder',
  'list_agent_reminders',
  'subscribe_agent_event',
  'unsubscribe_agent_event',
  'list_agent_event_subscriptions',
];

const GOAL_TOOL_NAMES: SpaceGoalToolName[] = [
  'list_goals',
  'get_goal',
  'create_goal',
  'update_goal',
  'pause_goal',
  'resume_goal',
  'trigger_goal_task',
  'list_goal_tasks',
  'list_goal_events',
];

const FORGE_TOOL_NAMES: SpaceForgeToolName[] = [
  'create_forge_scope',
  'create_forge_scope_from_goal',
  'list_forge_scopes',
  'get_forge_scope',
  'update_forge_scope',
  'get_forge_timeline',
  'add_forge_manual_note',
  'attach_forge_task_evidence',
  'attach_forge_workflow_run_evidence',
  'add_forge_metric_snapshot',
  'list_forge_evidence',
  'list_forge_metric_snapshots',
  'create_forge_episode',
  'list_forge_review_bundle',
  'list_forge_lessons',
  'list_forge_proposals',
  'resolve_forge_scope',
  'update_forge_episode',
  'update_forge_lesson',
  'create_forge_task_proposal',
  'update_forge_task_proposal',
  'create_task_from_forge_proposal',
  'apply_forge_rollup',
];

describe('conditional family tool schema maps', () => {
  test('SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS contains exactly the 17 agent-lifecycle tools', () => {
    expect(Object.keys(SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS).sort()).toEqual(
      [...LIFECYCLE_TOOL_NAMES].sort()
    );
    expect(Object.keys(SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS)).toHaveLength(17);
  });

  test('SPACE_GOAL_TOOL_SCHEMAS contains exactly the 9 goal tools', () => {
    expect(Object.keys(SPACE_GOAL_TOOL_SCHEMAS).sort()).toEqual([...GOAL_TOOL_NAMES].sort());
    expect(Object.keys(SPACE_GOAL_TOOL_SCHEMAS)).toHaveLength(9);
  });

  test('SPACE_FORGE_TOOL_SCHEMAS contains exactly the 23 Forge tools', () => {
    expect(Object.keys(SPACE_FORGE_TOOL_SCHEMAS).sort()).toEqual([...FORGE_TOOL_NAMES].sort());
    expect(Object.keys(SPACE_FORGE_TOOL_SCHEMAS)).toHaveLength(23);
  });

  test('family maps do not overlap the base map', () => {
    const base = new Set(Object.keys(SPACE_AGENT_TOOL_SCHEMAS));
    for (const family of [
      SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS,
      SPACE_GOAL_TOOL_SCHEMAS,
      SPACE_FORGE_TOOL_SCHEMAS,
    ]) {
      for (const name of Object.keys(family)) {
        expect(base.has(name)).toBe(false);
      }
    }
  });
});

interface FamilySafeParsePin {
  tool: string;
  accepts: Array<{ input: unknown; data?: Record<string, unknown> }>;
  rejects: unknown[];
}

const LIFECYCLE_PINS: FamilySafeParsePin[] = [
  {
    tool: 'list_agents',
    accepts: [
      { input: {}, data: {} },
      {
        input: { status: 'paused', compact: true },
        data: { status: 'paused', compact: true },
      },
    ],
    rejects: [{ status: 'done' }, { status: 'completed' }, { compact: 'yes' }],
  },
  {
    tool: 'get_agent',
    accepts: [{ input: { agent_id: 'a1' }, data: { agent_id: 'a1' } }],
    rejects: [{}, { agent_id: 5 }],
  },
  {
    tool: 'create_agent',
    accepts: [
      { input: { name: 'Watcher' }, data: { name: 'Watcher' } },
      {
        input: {
          name: 'Watcher',
          description: 'watches',
          model: 'glm-5.3',
          thinking_level: 'think16k',
          provider: 'zai',
          custom_prompt: null,
          tools: ['read_file'],
          setting_sources: ['user', 'project'],
        },
        data: {
          name: 'Watcher',
          description: 'watches',
          model: 'glm-5.3',
          thinking_level: 'think16k',
          provider: 'zai',
          custom_prompt: null,
          tools: ['read_file'],
          setting_sources: ['user', 'project'],
        },
      },
    ],
    rejects: [
      {},
      { name: '' },
      { name: 'W', thinking_level: 'think64k' },
      { name: 'W', setting_sources: ['bogus'] },
    ],
  },
  {
    tool: 'create_agent_from_template',
    accepts: [
      {
        input: {
          template_name: 'Coder',
          name: 'My Coder',
          model: 'm',
          provider: 'p',
          thinking_level: 'off',
        },
        data: {
          template_name: 'Coder',
          name: 'My Coder',
          model: 'm',
          provider: 'p',
          thinking_level: 'off',
        },
      },
    ],
    rejects: [{}, { name: 'My Coder' }],
  },
  {
    tool: 'list_agent_templates',
    accepts: [{ input: {}, data: {} }],
    rejects: ['not-an-object'],
  },
  {
    tool: 'update_agent',
    accepts: [
      {
        input: {
          agent_id: 'a1',
          status: 'disabled',
          name: 'Renamed',
          description: null,
          model: null,
          thinking_level: null,
          provider: null,
          custom_prompt: null,
          tools: null,
          setting_sources: null,
        },
        data: {
          agent_id: 'a1',
          status: 'disabled',
          name: 'Renamed',
          description: null,
          model: null,
          thinking_level: null,
          provider: null,
          custom_prompt: null,
          tools: null,
          setting_sources: null,
        },
      },
      { input: { agent_id: 'a1' }, data: { agent_id: 'a1' } },
    ],
    rejects: [
      {},
      { agent_id: 'a1', status: 'completed' },
      { agent_id: 'a1', thinking_level: 'think64k' },
    ],
  },
  {
    tool: 'pause_agent',
    accepts: [{ input: { agent_id: 'a1' }, data: { agent_id: 'a1' } }],
    rejects: [{}],
  },
  {
    tool: 'archive_agent',
    accepts: [{ input: { agent_id: 'a1' }, data: { agent_id: 'a1' } }],
    rejects: [{}],
  },
  {
    tool: 'assign_agent_to_goal',
    accepts: [
      { input: { agent_id: 'a1', goal_id: 'g1' }, data: { agent_id: 'a1', goal_id: 'g1' } },
    ],
    rejects: [{ agent_id: 'a1' }, { goal_id: 'g1' }],
  },
  {
    tool: 'unassign_agent_from_goal',
    accepts: [
      { input: { agent_id: 'a1', goal_id: 'g1' }, data: { agent_id: 'a1', goal_id: 'g1' } },
    ],
    rejects: [{}],
  },
  {
    tool: 'assign_agent_to_forge_scope',
    accepts: [
      { input: { agent_id: 'a1', scope_id: 'sc1' }, data: { agent_id: 'a1', scope_id: 'sc1' } },
    ],
    rejects: [{ agent_id: 'a1' }, { scope_id: 'sc1' }],
  },
  {
    tool: 'unassign_agent_from_forge_scope',
    accepts: [
      { input: { agent_id: 'a1', scope_id: 'sc1' }, data: { agent_id: 'a1', scope_id: 'sc1' } },
    ],
    rejects: [{}],
  },
  {
    tool: 'create_agent_reminder',
    accepts: [
      {
        input: { agent_id: 'a1', message: 'check in', remind_at: 1700000000000 },
        data: { agent_id: 'a1', message: 'check in', remind_at: 1700000000000 },
      },
    ],
    rejects: [
      {},
      { agent_id: 'a1', message: '', remind_at: 1 },
      { agent_id: 'a1', message: 'm', remind_at: 1.5 },
    ],
  },
  {
    tool: 'list_agent_reminders',
    accepts: [
      { input: { agent_id: 'a1' }, data: { agent_id: 'a1' } },
      { input: { agent_id: 'a1', status: 'done' }, data: { agent_id: 'a1', status: 'done' } },
    ],
    rejects: [{ agent_id: 'a1', status: 'archived' }, {}],
  },
  {
    tool: 'subscribe_agent_event',
    accepts: [
      {
        input: { agent_id: 'a1', topic_pattern: 'github/*/*/pull_request/*', label: 'PRs' },
        data: { agent_id: 'a1', topic_pattern: 'github/*/*/pull_request/*', label: 'PRs' },
      },
    ],
    rejects: [{ agent_id: 'a1' }, { topic_pattern: 't' }],
  },
  {
    tool: 'unsubscribe_agent_event',
    accepts: [
      {
        input: { agent_id: 'a1', topic_pattern: 'github/*/*/pull_request/*' },
        data: { agent_id: 'a1', topic_pattern: 'github/*/*/pull_request/*' },
      },
    ],
    rejects: [{}],
  },
  {
    tool: 'list_agent_event_subscriptions',
    accepts: [{ input: { agent_id: 'a1' }, data: { agent_id: 'a1' } }],
    rejects: [{}],
  },
];

const GOAL_PINS: FamilySafeParsePin[] = [
  {
    tool: 'list_goals',
    accepts: [
      { input: {}, data: {} },
      { input: { status: 'completed' }, data: { status: 'completed' } },
    ],
    rejects: [{ status: 'disabled' }, { status: 'done' }],
  },
  {
    tool: 'get_goal',
    accepts: [{ input: { goal_id: 'g1' }, data: { goal_id: 'g1' } }],
    rejects: [{}],
  },
  {
    tool: 'create_goal',
    accepts: [
      {
        input: {
          title: 'Ship v2',
          description: 'd',
          type: 'measurable',
          priority: 'urgent',
          labels: ['infra'],
          metrics: { deploys: 3 },
          summary: 'rolling',
          progress: 40,
          next_steps: ['step'],
          preferred_workflow_id: 'wf1',
          auto_trigger_next: true,
          check_in_cron_expression: '0 9 * * 1',
          check_in_timezone: 'UTC',
          trigger_immediately: true,
          owner_agent_id: null,
          workspace_path: null,
        },
        data: {
          title: 'Ship v2',
          description: 'd',
          type: 'measurable',
          priority: 'urgent',
          labels: ['infra'],
          metrics: { deploys: 3 },
          summary: 'rolling',
          progress: 40,
          next_steps: ['step'],
          preferred_workflow_id: 'wf1',
          auto_trigger_next: true,
          check_in_cron_expression: '0 9 * * 1',
          check_in_timezone: 'UTC',
          trigger_immediately: true,
          owner_agent_id: null,
          workspace_path: null,
        },
      },
    ],
    rejects: [
      {},
      { title: '' },
      { title: 'T', type: 'recurring_forever' },
      { title: 'T', progress: 101 },
      { title: 'T', metrics: { bad: {} } },
    ],
  },
  {
    tool: 'update_goal',
    accepts: [
      { input: { goal_id: 'g1' }, data: { goal_id: 'g1' } },
      {
        input: {
          goal_id: 'g1',
          status: 'archived',
          check_in_cron_expression: null,
          workspace_path: null,
          metrics: { ratio: 0.5 },
          progress: 100,
        },
        data: {
          goal_id: 'g1',
          status: 'archived',
          check_in_cron_expression: null,
          workspace_path: null,
          metrics: { ratio: 0.5 },
          progress: 100,
        },
      },
    ],
    rejects: [
      {},
      { goal_id: 'g1', status: 'disabled' },
      { goal_id: 'g1', progress: -1 },
      { goal_id: 'g1', metrics: { bad: [] } },
    ],
  },
  {
    tool: 'pause_goal',
    accepts: [{ input: { goal_id: 'g1' }, data: { goal_id: 'g1' } }],
    rejects: [{}],
  },
  {
    tool: 'resume_goal',
    accepts: [{ input: { goal_id: 'g1' }, data: { goal_id: 'g1' } }],
    rejects: [{}],
  },
  {
    tool: 'trigger_goal_task',
    accepts: [{ input: { goal_id: 'g1' }, data: { goal_id: 'g1' } }],
    rejects: [{}],
  },
  {
    tool: 'list_goal_tasks',
    accepts: [
      { input: { goal_id: 'g1' }, data: { goal_id: 'g1' } },
      {
        input: {
          goal_id: 'g1',
          status: 'blocked',
          limit: 100,
          before: 1700000000000,
          before_id: 't1',
        },
        data: {
          goal_id: 'g1',
          status: 'blocked',
          limit: 100,
          before: 1700000000000,
          before_id: 't1',
        },
      },
    ],
    rejects: [
      { goal_id: 'g1', status: 'paused' },
      { goal_id: 'g1', limit: 101 },
      { goal_id: 'g1', limit: 0 },
      {},
    ],
  },
  {
    tool: 'list_goal_events',
    accepts: [
      { input: { goal_id: 'g1' }, data: { goal_id: 'g1' } },
      {
        input: { goal_id: 'g1', limit: 100, before: 123, before_id: 'e1' },
        data: { goal_id: 'g1', limit: 100, before: 123, before_id: 'e1' },
      },
    ],
    rejects: [{ goal_id: 'g1', limit: 101 }, {}],
  },
];

const FORGE_PINS: FamilySafeParsePin[] = [
  {
    tool: 'create_forge_scope',
    accepts: [
      {
        input: {
          goal_id: null,
          kind: 'campaign',
          name: 'Reliability',
          objective: 'Keep p99 low',
          parent_scope_id: 'sc0',
          metric_definitions: [
            {
              key: 'p99',
              label: 'P99 latency',
              description: 'ms',
              direction: 'decrease',
              targetValue: 250,
              unit: 'ms',
            },
          ],
          policy: { episodeJudgeModel: 'glm-5.3' },
        },
        data: {
          goal_id: null,
          kind: 'campaign',
          name: 'Reliability',
          objective: 'Keep p99 low',
          parent_scope_id: 'sc0',
          metric_definitions: [
            {
              key: 'p99',
              label: 'P99 latency',
              description: 'ms',
              direction: 'decrease',
              targetValue: 250,
              unit: 'ms',
            },
          ],
          policy: { episodeJudgeModel: 'glm-5.3' },
        },
      },
    ],
    rejects: [
      {},
      { kind: 'mission', name: 'N', objective: '' },
      { kind: 'bogus', name: 'N', objective: 'O' },
      {
        kind: 'mission',
        name: 'N',
        objective: 'O',
        metric_definitions: [{ key: '', label: 'L', direction: 'increase' }],
      },
    ],
  },
  {
    tool: 'create_forge_scope_from_goal',
    accepts: [
      {
        input: { goal_id: 'g1', name: 'N', objective: 'O', metric_definitions: [], policy: {} },
        data: { goal_id: 'g1', name: 'N', objective: 'O', metric_definitions: [], policy: {} },
      },
    ],
    rejects: [{}],
  },
  {
    tool: 'list_forge_scopes',
    accepts: [
      { input: {}, data: {} },
      { input: { goal_id: null, kind: 'mission' }, data: { goal_id: null, kind: 'mission' } },
    ],
    rejects: [{ goal_id: 'g1', kind: 'bogus' }],
  },
  {
    tool: 'get_forge_scope',
    accepts: [{ input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } }],
    rejects: [{}],
  },
  {
    tool: 'update_forge_scope',
    accepts: [
      {
        input: {
          scope_id: 'sc1',
          goal_id: null,
          kind: 'project',
          name: 'N2',
          objective: 'O2',
          parent_scope_id: null,
          metric_definitions: [],
          policy: { a: 1 },
          policy_patch: { automation: { enabled: true } },
          episode_judge_model: null,
          episode_judge_provider: null,
        },
        data: {
          scope_id: 'sc1',
          goal_id: null,
          kind: 'project',
          name: 'N2',
          objective: 'O2',
          parent_scope_id: null,
          metric_definitions: [],
          policy: { a: 1 },
          policy_patch: { automation: { enabled: true } },
          episode_judge_model: null,
          episode_judge_provider: null,
        },
      },
      { input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } },
    ],
    rejects: [{}, { scope_id: 'sc1', kind: 'bogus' }, { scope_id: 'sc1', name: '' }],
  },
  {
    tool: 'get_forge_timeline',
    accepts: [{ input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } }],
    rejects: [{}],
  },
  {
    tool: 'add_forge_manual_note',
    accepts: [
      {
        input: { scope_id: 'sc1', summary: 'note', metadata: { k: 'v' }, created_at: 123 },
        data: { scope_id: 'sc1', summary: 'note', metadata: { k: 'v' }, created_at: 123 },
      },
    ],
    rejects: [{}, { scope_id: 'sc1', summary: '' }],
  },
  {
    tool: 'attach_forge_task_evidence',
    accepts: [
      { input: { task_id: 't1' }, data: { task_id: 't1' } },
      {
        input: { task_id: 't1', scope_id: 'sc1', summary: 's', metadata: {} },
        data: { task_id: 't1', scope_id: 'sc1', summary: 's', metadata: {} },
      },
    ],
    rejects: [{}, { scope_id: 'sc1' }],
  },
  {
    tool: 'attach_forge_workflow_run_evidence',
    accepts: [
      {
        input: { workflow_run_id: 'r1', scope_id: 'sc1', summary: 's', metadata: {} },
        data: { workflow_run_id: 'r1', scope_id: 'sc1', summary: 's', metadata: {} },
      },
    ],
    rejects: [{}],
  },
  {
    tool: 'add_forge_metric_snapshot',
    accepts: [
      {
        input: {
          scope_id: 'sc1',
          values: { p99: 250, ok: true, note: null, label: 'x' },
          source: 'CI',
          note: null,
          captured_at: 123,
          summary: 'snap',
          metadata: {},
        },
        data: {
          scope_id: 'sc1',
          values: { p99: 250, ok: true, note: null, label: 'x' },
          source: 'CI',
          note: null,
          captured_at: 123,
          summary: 'snap',
          metadata: {},
        },
      },
    ],
    rejects: [
      {},
      { scope_id: 'sc1', source: 'CI' },
      { scope_id: 'sc1', values: { bad: [] }, source: 'CI' },
      { scope_id: 'sc1', values: {}, source: '' },
    ],
  },
  {
    tool: 'list_forge_evidence',
    accepts: [{ input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } }],
    rejects: [{}],
  },
  {
    tool: 'list_forge_metric_snapshots',
    accepts: [{ input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } }],
    rejects: [{}],
  },
  {
    tool: 'create_forge_episode',
    accepts: [
      {
        input: { scope_id: 'sc1', evidence_ids: ['e1', 'e2'], time_window: null },
        data: { scope_id: 'sc1', evidence_ids: ['e1', 'e2'], time_window: null },
      },
      {
        input: {
          scope_id: 'sc1',
          evidence_ids: ['e1'],
          time_window: { start: 1, end: 2 },
          confirm_low_confidence: true,
        },
        data: {
          scope_id: 'sc1',
          evidence_ids: ['e1'],
          time_window: { start: 1, end: 2 },
          confirm_low_confidence: true,
        },
      },
    ],
    rejects: [
      {},
      { scope_id: 'sc1', evidence_ids: [] },
      { scope_id: 'sc1', evidence_ids: ['e1'], time_window: { start: 1 } },
    ],
  },
  {
    tool: 'list_forge_review_bundle',
    accepts: [{ input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } }],
    rejects: [{}],
  },
  {
    tool: 'list_forge_lessons',
    accepts: [
      { input: { scope_id: 'sc1' }, data: { scope_id: 'sc1' } },
      {
        input: { scope_id: 'sc1', status: 'candidate' },
        data: { scope_id: 'sc1', status: 'candidate' },
      },
    ],
    rejects: [{ scope_id: 'sc1', status: 'bogus' }, {}],
  },
  {
    tool: 'list_forge_proposals',
    accepts: [
      {
        input: { scope_id: 'sc1', status: 'created' },
        data: { scope_id: 'sc1', status: 'created' },
      },
    ],
    rejects: [{ scope_id: 'sc1', status: 'bogus' }, {}],
  },
  {
    tool: 'resolve_forge_scope',
    accepts: [
      { input: {}, data: {} },
      { input: { goal_id: 'g1' }, data: { goal_id: 'g1' } },
      { input: { task_id: 't1' }, data: { task_id: 't1' } },
    ],
    rejects: [{ goal_id: 5 }],
  },
  {
    tool: 'update_forge_episode',
    accepts: [
      {
        input: { episode_id: 'ep1', status: 'accepted', title: 'T', outcome_summary: 'S' },
        data: { episode_id: 'ep1', status: 'accepted', title: 'T', outcome_summary: 'S' },
      },
    ],
    rejects: [{}, { episode_id: 'ep1', status: 'bogus' }, { episode_id: 'ep1', title: '' }],
  },
  {
    tool: 'update_forge_lesson',
    accepts: [
      {
        input: {
          lesson_id: 'l1',
          status: 'active',
          applies_to: ['workflow'],
          rule: 'Keep evidence scoped',
          why: 'Reduces drift',
          confidence: 0.9,
        },
        data: {
          lesson_id: 'l1',
          status: 'active',
          applies_to: ['workflow'],
          rule: 'Keep evidence scoped',
          why: 'Reduces drift',
          confidence: 0.9,
        },
      },
    ],
    rejects: [
      {},
      { lesson_id: 'l1', status: 'bogus' },
      { lesson_id: 'l1', confidence: 1.5 },
      { lesson_id: 'l1', rule: '' },
    ],
  },
  {
    tool: 'create_forge_task_proposal',
    accepts: [
      {
        input: {
          scope_id: 'sc1',
          title: 'T',
          description: 'D',
          reason: 'R',
          priority: 'high',
          evidence_episode_ids: ['ep1'],
        },
        data: {
          scope_id: 'sc1',
          title: 'T',
          description: 'D',
          reason: 'R',
          priority: 'high',
          evidence_episode_ids: ['ep1'],
        },
      },
    ],
    rejects: [{}, { title: 'T', description: 'D', reason: 'R' }],
  },
  {
    tool: 'update_forge_task_proposal',
    accepts: [
      {
        input: { proposal_id: 'p1', status: 'dismissed', priority: 'low' },
        data: { proposal_id: 'p1', status: 'dismissed', priority: 'low' },
      },
    ],
    rejects: [{}, { proposal_id: 'p1', status: 'created' }, { proposal_id: 'p1', title: '' }],
  },
  {
    tool: 'create_task_from_forge_proposal',
    accepts: [
      {
        input: {
          proposal_id: 'p1',
          title: 'T',
          description: 'D',
          reason: 'R',
          priority: 'normal',
          depends_on: ['t1', 't2'],
        },
        data: {
          proposal_id: 'p1',
          title: 'T',
          description: 'D',
          reason: 'R',
          priority: 'normal',
          depends_on: ['t1', 't2'],
        },
      },
    ],
    rejects: [{}, { proposal_id: 'p1', priority: 'bogus' }],
  },
  {
    tool: 'apply_forge_rollup',
    accepts: [
      {
        input: { episode_id: 'ep1', goal_update: {} },
        data: { episode_id: 'ep1', goal_update: {} },
      },
      {
        input: {
          episode_id: 'ep1',
          goal_update: { summary: 's', progress: 50, next_steps: ['a'], metrics: { m: 1 } },
        },
        data: {
          episode_id: 'ep1',
          goal_update: { summary: 's', progress: 50, next_steps: ['a'], metrics: { m: 1 } },
        },
      },
    ],
    rejects: [
      {},
      { episode_id: 'ep1' },
      { episode_id: 'ep1', goal_update: { progress: 101 } },
      { episode_id: 'ep1', goal_update: { metrics: { bad: [] } } },
    ],
  },
];

function runFamilyPins(
  suiteName: string,
  schemasMap: Record<string, z.ZodType>,
  pins: FamilySafeParsePin[]
) {
  describe(suiteName, () => {
    test('pins cover every tool', () => {
      expect(pins.map((pin) => pin.tool).sort()).toEqual(Object.keys(schemasMap).sort());
    });

    for (const pin of pins) {
      const schema = schemasMap[pin.tool];
      describe(pin.tool, () => {
        for (const { input, data } of pin.accepts) {
          test(`accepts ${JSON.stringify(input)}`, () => {
            const result = schema.safeParse(input);
            expect(result.success).toBe(true);
            if (data && result.success) {
              expect(result.data).toEqual(data);
            }
          });
        }
        for (const input of pin.rejects) {
          test(`rejects ${JSON.stringify(input)}`, () => {
            expect(schema.safeParse(input).success).toBe(false);
          });
        }
      });
    }
  });
}

runFamilyPins(
  'SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS safeParse pins',
  SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS as unknown as Record<string, z.ZodType>,
  LIFECYCLE_PINS
);

runFamilyPins(
  'SPACE_GOAL_TOOL_SCHEMAS safeParse pins',
  SPACE_GOAL_TOOL_SCHEMAS as unknown as Record<string, z.ZodType>,
  GOAL_PINS
);

runFamilyPins(
  'SPACE_FORGE_TOOL_SCHEMAS safeParse pins',
  SPACE_FORGE_TOOL_SCHEMAS as unknown as Record<string, z.ZodType>,
  FORGE_PINS
);
