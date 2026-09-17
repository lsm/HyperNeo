import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  ListAgentEventSubscriptionsSchema,
  SubscribeAgentEventSchema,
  UnsubscribeAgentEventSchema,
} from '../../../../src/lib/space/actions/space-agent-schemas.ts';

interface FamilySafeParsePin {
  tool: string;
  schema: z.ZodType;
  accepts: Array<{ input: unknown; data?: Record<string, unknown> }>;
  rejects: unknown[];
}

const PINS: FamilySafeParsePin[] = [
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
