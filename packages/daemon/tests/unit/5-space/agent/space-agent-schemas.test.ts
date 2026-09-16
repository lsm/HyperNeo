import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  CreateAgentFromTemplateSchema,
  CreateAgentTemplateSchema,
  DeleteAgentTemplateSchema,
  ListAgentEventSubscriptionsSchema,
  ListAgentTemplatesSchema,
  SubscribeAgentEventSchema,
  UnsubscribeAgentEventSchema,
  UpdateAgentTemplateSchema,
} from '../../../../src/lib/space/actions/space-agent-schemas.ts';

interface FamilySafeParsePin {
  tool: string;
  schema: z.ZodType;
  accepts: Array<{ input: unknown; data?: Record<string, unknown> }>;
  rejects: unknown[];
}

const PINS: FamilySafeParsePin[] = [
  {
    tool: 'create_agent_from_template',
    schema: CreateAgentFromTemplateSchema,
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
    tool: 'create_agent_template',
    schema: CreateAgentTemplateSchema,
    accepts: [
      {
        input: {
          key: 'reviewer.custom',
          handle: 'reviewer',
          display_name: 'Reviewer',
          description: 'Reviews code',
          instructions: 'You review code.',
          labels: ['workflow-worker'],
          suggested_autonomy_level: 3,
          model: 'glm-5.3',
          provider: 'zai',
          model_pool: [{ model: 'glm-5.3', maxConcurrent: 2, weight: 1 }],
          thinking_level: 'think16k',
          setting_sources: ['user', 'project'],
          tools: ['read_file'],
          from_agent_id: 'a1',
        },
        data: {
          key: 'reviewer.custom',
          handle: 'reviewer',
          display_name: 'Reviewer',
          description: 'Reviews code',
          instructions: 'You review code.',
          labels: ['workflow-worker'],
          suggested_autonomy_level: 3,
          model: 'glm-5.3',
          provider: 'zai',
          model_pool: [{ model: 'glm-5.3', maxConcurrent: 2, weight: 1 }],
          thinking_level: 'think16k',
          setting_sources: ['user', 'project'],
          tools: ['read_file'],
          from_agent_id: 'a1',
        },
      },
      {
        input: { key: 'k', handle: 'h', model: null, tools: null },
        data: { key: 'k', handle: 'h', model: null, tools: null },
      },
    ],
    rejects: [
      {},
      { handle: 'h' },
      { key: 'k' },
      { key: '', handle: 'h' },
      { key: 'k', handle: 'h', suggested_autonomy_level: 6 },
      { key: 'k', handle: 'h', thinking_level: 'think64k' },
      { key: 'k', handle: 'h', setting_sources: ['bogus'] },
      { key: 'k', handle: 'h', model_pool: [{ model: 'm', maxConcurrent: 0, weight: 1 }] },
    ],
  },
  {
    tool: 'update_agent_template',
    schema: UpdateAgentTemplateSchema,
    accepts: [
      {
        input: {
          key: 'reviewer.custom',
          expected_version: 2,
          display_name: 'Reviewer',
          description: 'Reviews code',
          instructions: 'You review code.',
          labels: ['workflow-worker'],
          model: 'glm-5.3',
          provider: 'zai',
          model_pool: [{ model: 'glm-5.3', maxConcurrent: 2, weight: 1 }],
          thinking_level: 'think16k',
          setting_sources: ['user', 'project'],
          tools: ['read_file'],
        },
        data: {
          key: 'reviewer.custom',
          expected_version: 2,
          display_name: 'Reviewer',
          description: 'Reviews code',
          instructions: 'You review code.',
          labels: ['workflow-worker'],
          model: 'glm-5.3',
          provider: 'zai',
          model_pool: [{ model: 'glm-5.3', maxConcurrent: 2, weight: 1 }],
          thinking_level: 'think16k',
          setting_sources: ['user', 'project'],
          tools: ['read_file'],
        },
      },
      {
        input: { key: 'k', labels: null, model: null, tools: null },
        data: { key: 'k', labels: null, model: null, tools: null },
      },
    ],
    rejects: [
      {},
      { expected_version: 1 },
      { key: '' },
      { key: 'k', expected_version: 0 },
      { key: 'k', expected_version: 1.5 },
      { key: 'k', thinking_level: 'think64k' },
      { key: 'k', setting_sources: ['bogus'] },
      { key: 'k', model_pool: [{ model: 'm', maxConcurrent: 0, weight: 1 }] },
    ],
  },
  {
    tool: 'list_agent_templates',
    schema: ListAgentTemplatesSchema,
    accepts: [{ input: {}, data: {} }],
    rejects: ['not-an-object'],
  },
  {
    tool: 'delete_agent_template',
    schema: DeleteAgentTemplateSchema,
    accepts: [
      { input: { key: 'reviewer.custom' }, data: { key: 'reviewer.custom' } },
      {
        input: { key: 'reviewer.custom', expected_version: 3 },
        data: { key: 'reviewer.custom', expected_version: 3 },
      },
    ],
    rejects: [
      {},
      { key: '' },
      { expected_version: 1 },
      { key: 'k', expected_version: 0 },
      { key: 'k', expected_version: 1.5 },
      { key: 'k', expected_version: '2' },
    ],
  },
  {
    tool: 'subscribe_agent_event',
    schema: SubscribeAgentEventSchema,
    accepts: [
      {
        input: { agent_id: 'a1', topic_pattern: 'github/*' },
        data: { agent_id: 'a1', topic_pattern: 'github/*' },
      },
      {
        input: { agent_id: 'a1', topic_pattern: 'github/*', label: 'l1' },
        data: { agent_id: 'a1', topic_pattern: 'github/*', label: 'l1' },
      },
    ],
    rejects: [{}, { agent_id: 'a1' }],
  },
  {
    tool: 'unsubscribe_agent_event',
    schema: UnsubscribeAgentEventSchema,
    accepts: [
      {
        input: { agent_id: 'a1', topic_pattern: 'github/*' },
        data: { agent_id: 'a1', topic_pattern: 'github/*' },
      },
    ],
    rejects: [{}],
  },
  {
    tool: 'list_agent_event_subscriptions',
    schema: ListAgentEventSubscriptionsSchema,
    accepts: [{ input: { agent_id: 'a1' }, data: { agent_id: 'a1' } }],
    rejects: [{}],
  },
];

describe('space agent tool schemas safeParse pins', () => {
  for (const pin of PINS) {
    describe(pin.tool, () => {
      for (const { input, data } of pin.accepts) {
        test(`accepts ${JSON.stringify(input)}`, () => {
          const result = pin.schema.safeParse(input);
          expect(result.success).toBe(true);
          if (data && result.success) {
            expect(result.data).toEqual(data);
          }
        });
      }
      for (const input of pin.rejects) {
        test(`rejects ${JSON.stringify(input)}`, () => {
          expect(pin.schema.safeParse(input).success).toBe(false);
        });
      }
    });
  }
});
