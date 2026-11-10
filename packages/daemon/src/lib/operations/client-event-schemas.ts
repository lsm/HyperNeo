import { z } from 'zod';
import { SessionEventSchema, SettingsEventSchema } from './client-state-event-schemas.ts';

const SpeechIdentity = { id: z.string(), sessionId: z.string() };
const SpeechEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('say'),
    ...SpeechIdentity,
    text: z.string(),
    format: z.literal('pcm16').optional(),
    sampleRate: z.number().optional(),
  }),
  z.object({ type: z.literal('stop'), sessionId: z.string() }),
  z.object({ type: z.literal('audio'), ...SpeechIdentity, seq: z.number(), pcm: z.string() }),
  z.object({ type: z.literal('end'), ...SpeechIdentity, seq: z.number() }),
  z.object({ type: z.literal('failed'), ...SpeechIdentity }),
]);
const Rows = z
  .array(z.record(z.string(), z.unknown()))
  .describe(
    'Query-specific row contents remain open records; the event envelope does not define each query row model.'
  );
const Query = {
  subscriptionId: z.string(),
  version: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};
export const CLIENT_EVENT_SCHEMAS = {
  'liveQuery.delta': z.object({
    ...Query,
    added: Rows.optional(),
    removed: Rows.optional(),
    updated: Rows.optional(),
    rowCount: z.number().optional(),
  }),
  'liveQuery.snapshot': z.object({ ...Query, rows: Rows }),
  'neo.changed': z.object({}),
  'neo.speech': SpeechEvent,
  'state.session': SessionEventSchema,
  'state.settings': SettingsEventSchema,
  'voice.stream.text': z.object({ streamId: z.string(), text: z.string(), isFinal: z.boolean() }),
} as const;
export type ClientEventData<Method extends keyof typeof CLIENT_EVENT_SCHEMAS> = z.infer<
  (typeof CLIENT_EVENT_SCHEMAS)[Method]
>;
