import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';

export type OapHubFrame =
  | { kind: 'response'; id: number; result: unknown }
  | {
      kind: 'refusal';
      id: number;
      code: string;
      message: string;
      retryable: boolean;
    }
  | {
      kind: 'event';
      id: number;
      event: string;
      data: Record<string, unknown>;
    };

const HubId = z.number().refine(Number.isSafeInteger, 'Hub id must be a safe integer');
const WireFrame = z.union([
  z
    .looseObject({ id: HubId, event: z.string().min(1) })
    .refine((frame) => !Object.hasOwn(frame, 'ok'), 'Event cannot also be a response'),
  z
    .strictObject({ id: HubId, ok: z.literal(true), result: z.unknown() })
    .refine((frame) => Object.hasOwn(frame, 'result'), 'Response needs a result'),
  z.strictObject({
    id: HubId,
    ok: z.literal(false),
    result: z.null().optional(),
    error: z.looseObject({ code: z.string().min(1), message: z.string() }),
  }),
]);
const Request = z.object({
  id: HubId,
  op: z.string().min(1),
  parameters: z
    .record(z.string(), z.unknown())
    .refine(
      (parameters) => !Object.hasOwn(parameters, 'id') && !Object.hasOwn(parameters, 'op'),
      'Parameters cannot replace id or op'
    ),
});

function readFrame(line: string): z.infer<typeof WireFrame> {
  return WireFrame.parse(JSON.parse(line));
}

function classifyFrame(frame: z.infer<typeof WireFrame>): OapHubFrame {
  if ('event' in frame) return { kind: 'event', id: frame.id, event: frame.event, data: frame };
  if (!frame.ok)
    return {
      kind: 'refusal',
      id: frame.id,
      code: frame.error.code,
      message: frame.error.message,
      retryable: frame.error.code === 'busy',
    };
  return { kind: 'response', id: frame.id, result: frame.result };
}

function prepareRequest(id: number, op: string, parameters: Record<string, unknown>) {
  return Request.parse({ id, op, parameters });
}

function writeRequest(request: z.infer<typeof Request>): string {
  return `${JSON.stringify({ id: request.id, op: request.op, ...request.parameters })}\n`;
}

const encode = (superpipe({})('oap.hub.encode') as PipelineAPI)
  .input(['id', 'op', 'parameters'])
  .pipe(prepareRequest, ['id', 'op', 'parameters'], 'request')
  .pipe(writeRequest, 'request', 'line')
  .end('line') as (id: number, op: string, parameters: Record<string, unknown>) => string;

export function encodeOapHubRequest(
  id: number,
  op: string,
  parameters: Record<string, unknown> = {}
): string {
  return encode(id, op, parameters);
}

export const decodeOapHubLine = (superpipe({})('oap.hub.decode') as PipelineAPI)
  .input('line')
  .pipe(readFrame, 'line', 'frame')
  .pipe(classifyFrame, 'frame', 'decoded')
  .end('decoded') as (line: string) => OapHubFrame;
