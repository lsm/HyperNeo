import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  HANDOFF_CHUNK_BYTES,
  HandoffName,
  HandoffReference,
  publishHandoff,
  readHandoff,
} from './outbox.ts';

const Rejection = z.object({ kind: z.literal('rejected'), reason: z.string() });
const ReadResult = z.union([
  z.object({
    kind: z.literal('read'),
    data: z.string(),
    nextOffset: z.number(),
    complete: z.boolean(),
  }),
  z.object({ kind: z.literal('tampered') }),
  z.object({ kind: z.literal('unavailable') }),
  Rejection,
]);
type Reference = z.infer<typeof HandoffReference>;
type Rejected = z.infer<typeof Rejection>;

function requirePublisher(caller: OperationCaller, status: (id: string) => string | null) {
  const current = caller.sessionId ? status(caller.sessionId) : null;
  return caller.sessionId && current !== null && !sessionUnavailable(current)
    ? { value: caller.sessionId }
    : { reason: { kind: 'rejected' as const, reason: 'live_session_required' } };
}

function requireReader(ref: Reference, caller: OperationCaller) {
  return caller.source === 'rpc' || caller.role === 'neo' || caller.sessionId === ref.sessionId
    ? { value: ref }
    : { reason: { kind: 'rejected' as const, reason: 'session_scope' } };
}

async function publish(sessionId: string, name: string) {
  try {
    return await publishHandoff(getDataDir(), sessionId, name);
  } catch (error) {
    return rejected(error);
  }
}

async function read(ref: Reference, offset: number, length: number) {
  try {
    return await readHandoff(getDataDir(), ref, offset, length);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'unavailable' as const };
    return rejected(error);
  }
}

function rejected(error: unknown): Rejected {
  return { kind: 'rejected', reason: error instanceof Error ? error.message : String(error) };
}

const publishArtifact = (superpipe({})('publish-worker-handoff') as PipelineAPI)
  .input(['caller', 'status', 'name'])
  .pipe(requirePublisher, ['caller', 'status'], 'result:outcome')
  .pipe(publish, ['outcome', 'name'], 'outcome')
  .endAsync('outcome') as (
  caller: OperationCaller,
  status: (id: string) => string | null,
  name: string
) => Promise<unknown>;

const readArtifact = (superpipe({})('read-worker-handoff') as PipelineAPI)
  .input(['ref', 'caller', 'offset', 'length'])
  .pipe(requireReader, ['ref', 'caller'], 'result:outcome')
  .pipe(read, ['outcome', 'offset', 'length'], 'outcome')
  .endAsync('outcome') as (
  ref: Reference,
  caller: OperationCaller,
  offset: number,
  length: number
) => Promise<unknown>;

export function createHandoffOperations(status: (id: string) => string | null) {
  return [
    defineOperation({
      name: 'handoff.publish',
      description:
        'Publish a regular file from your HYPERNEO_HANDOFF_DIR. name is one filename, at most 128 characters, never a path. The daemon snapshots in 256 KiB chunks, without trimming or expiry, and returns a local SHA-256 reference for a message or report. Identical retries never replace an artifact. API immutability is not OS isolation from same-user Bash; reads detect tampering.',
      inputSchema: z.strictObject({ name: HandoffName }),
      resultSchema: z.union([
        z.object({ kind: z.literal('published'), reference: HandoffReference }),
        ReadResult,
      ]),
      policy: { safetyClass: 'mutate' },
      execute: (input, caller) => publishArtifact(caller, status, input.name),
    }),
    defineOperation({
      name: 'handoff.read',
      description:
        'Read a local published handoff by its complete reference, including SHA-256. Verifies the whole artifact before returning any bytes; a mismatch returns tampered without content. data is base64; continue at nextOffset until complete. At most 256 KiB per read. A foreign-daemon reference is unavailable; it is never reinterpreted as a local file. Neo and the human may read all published artifacts; workers may read only their own.',
      inputSchema: z.strictObject({
        reference: HandoffReference,
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().min(1).max(HANDOFF_CHUNK_BYTES).default(HANDOFF_CHUNK_BYTES),
      }),
      resultSchema: ReadResult,
      policy: { safetyClass: 'read' },
      execute: (input, caller) => readArtifact(input.reference, caller, input.offset, input.length),
    }),
  ];
}
