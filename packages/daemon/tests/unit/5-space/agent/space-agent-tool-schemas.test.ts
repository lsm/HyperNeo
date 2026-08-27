import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  SPACE_AGENT_TOOL_SCHEMAS,
  type SpaceAgentToolName,
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
