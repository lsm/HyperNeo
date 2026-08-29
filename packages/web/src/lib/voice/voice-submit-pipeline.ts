import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../connection-manager';
import { deleteVoiceRecord, putVoiceRecord, type VoiceRecordEntry } from './voice-audio-store.ts';
import { type VoiceRecording, voiceRecorderStore } from './voice-recorder-store.ts';
import {
  classifyVoiceSubmitError,
  routeVoiceOutcome,
  type VoiceSubmitMode,
  type VoiceSubmitOutcome,
  voiceRetryPolicy,
} from './voice-submit-routing.ts';

export const VOICE_SUBMIT_MAX_TRANSCRIBE_ATTEMPTS = 4;

const VOICE_SUBMIT_TRANSCRIBE_TIMEOUT_MS = 125_000;

export interface VoiceSubmitInput {
  sessionId: string;
  mode?: VoiceSubmitMode;
}

export interface VoiceSubmitDeps {
  stopRecording(): Promise<VoiceRecording>;
  transcribe(recording: VoiceRecording): Promise<{ text?: string }>;
  putRecord(entry: VoiceRecordEntry): Promise<boolean>;
  deleteRecord(id: string): Promise<boolean>;
  isMounted(): boolean;
  currentSessionId(): string;
  generateId(): string;
  now(): number;
  delay(ms: number): Promise<void>;
}

export type VoiceSubmitResult =
  | {
      kind: 'routed';
      outcome: VoiceSubmitOutcome;
      recordId: string;
      persisted: boolean;
      dequeued: boolean;
    }
  | {
      kind: 'transcribe-failed';
      message: string;
      attempts: number;
      recordId: string;
      persisted: boolean;
    };

interface VoiceSubmitSnapshot {
  recordId: string;
  startedAt: number;
}

interface VoiceSubmitEncoded extends VoiceSubmitSnapshot {
  recording: VoiceRecording;
}

interface VoiceSubmitPersisted extends VoiceSubmitEncoded {
  persisted: boolean;
}

interface VoiceSubmitTranscribed extends VoiceSubmitPersisted {
  transcript?: string;
  failure?: { message: string; attempts: number };
}

interface VoiceSubmitRouted extends VoiceSubmitTranscribed {
  outcome: VoiceSubmitOutcome;
}

interface VoiceSubmitFinished extends VoiceSubmitRouted {
  dequeued: boolean;
}

type VoiceSubmitCtx = VoiceSubmitInput & { deps: VoiceSubmitDeps };
type VoiceSubmitSnapshotCtx = VoiceSubmitSnapshot & VoiceSubmitCtx;
type VoiceSubmitEncodedCtx = VoiceSubmitEncoded & VoiceSubmitCtx;
type VoiceSubmitPersistedCtx = VoiceSubmitPersisted & VoiceSubmitCtx;
type VoiceSubmitTranscribedCtx = VoiceSubmitTranscribed & VoiceSubmitCtx;
type VoiceSubmitRoutedCtx = VoiceSubmitRouted & VoiceSubmitCtx;
type VoiceSubmitFinishedCtx = VoiceSubmitFinished & VoiceSubmitCtx;
type VoiceSubmitHaltedCtx = VoiceSubmitTranscribedCtx & {
  failure: { message: string; attempts: number };
};

export function isTerminalVoiceSubmitOutcome(outcome: VoiceSubmitOutcome): boolean {
  return outcome.kind === 'insert' || outcome.kind === 'discard-with-reason';
}

function voiceSubmitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Voice transcription failed';
}

function snapshotVoiceSubmit(ctx: VoiceSubmitCtx): VoiceSubmitSnapshotCtx {
  return { ...ctx, recordId: ctx.deps.generateId(), startedAt: ctx.deps.now() };
}

async function stopAndEncodeRecording(ctx: VoiceSubmitSnapshotCtx): Promise<VoiceSubmitEncodedCtx> {
  return { ...ctx, recording: await ctx.deps.stopRecording() };
}

async function persistVoiceAudio(ctx: VoiceSubmitEncodedCtx): Promise<VoiceSubmitPersistedCtx> {
  const recording = ctx.recording;
  const entry: VoiceRecordEntry = {
    id: ctx.recordId,
    sessionId: ctx.sessionId,
    audioBase64: recording.audioBase64,
    mimeType: recording.mimeType,
    hitDurationLimit: recording.hitDurationLimit,
    peakLevel: recording.peakLevel,
    createdAt: ctx.startedAt,
  };
  return { ...ctx, persisted: await ctx.deps.putRecord(entry) };
}

async function transcribeWithRetry(
  ctx: VoiceSubmitPersistedCtx
): Promise<VoiceSubmitTranscribedCtx> {
  let attempts = 0;
  let message = 'Voice transcription failed';
  for (let attempt = 0; attempt < VOICE_SUBMIT_MAX_TRANSCRIBE_ATTEMPTS; attempt++) {
    attempts = attempt + 1;
    if (attempt > 0) await ctx.deps.delay(voiceRetryPolicy(attempt - 1));
    try {
      const result = await ctx.deps.transcribe(ctx.recording);
      return { ...ctx, transcript: result.text?.trim() ?? '' };
    } catch (error) {
      message = voiceSubmitErrorMessage(error);
      if (classifyVoiceSubmitError(error, 'transcribe') !== 'retry') break;
    }
  }
  return { ...ctx, failure: { message, attempts } };
}

function routeSubmitOutcome(ctx: VoiceSubmitTranscribedCtx): VoiceSubmitRoutedCtx {
  const outcome = routeVoiceOutcome({
    transcript: ctx.transcript ?? '',
    mounted: ctx.deps.isMounted(),
    sessionChanged: ctx.deps.currentSessionId() !== ctx.sessionId,
    mode: ctx.mode,
  });
  return { ...ctx, outcome };
}

async function dequeueTerminalOutcome(ctx: VoiceSubmitRoutedCtx): Promise<VoiceSubmitFinishedCtx> {
  const dequeued = isTerminalVoiceSubmitOutcome(ctx.outcome)
    ? await ctx.deps.deleteRecord(ctx.recordId)
    : false;
  return { ...ctx, dequeued };
}

const runVoiceSubmitPipeline = (
  superpipe<{
    failed: (ctx: VoiceSubmitTranscribedCtx) => boolean;
  }>({
    failed: (ctx) => ctx.failure !== undefined,
  })('voice-submit') as PipelineAPI
)
  .input(['ctx'])
  .pipe(snapshotVoiceSubmit, 'ctx', 'ctx')
  .pipe(stopAndEncodeRecording, 'ctx', 'ctx')
  .pipe(persistVoiceAudio, 'ctx', 'ctx')
  .pipe(transcribeWithRetry, 'ctx', 'ctx')
  .pipe('!failed', 'ctx')
  .pipe(routeSubmitOutcome, 'ctx', 'ctx')
  .pipe(dequeueTerminalOutcome, 'ctx', 'ctx')
  .endAsync('ctx') as (
  ctx: VoiceSubmitCtx
) => Promise<VoiceSubmitFinishedCtx | VoiceSubmitHaltedCtx>;

async function requestVoiceTranscription(recording: VoiceRecording): Promise<{ text?: string }> {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) throw new Error('Not connected');
  return hub.request<{ text?: string }>('voice.transcribe', recording, {
    timeout: VOICE_SUBMIT_TRANSCRIBE_TIMEOUT_MS,
  });
}

export async function runVoiceSubmit(
  input: VoiceSubmitInput,
  deps: Partial<VoiceSubmitDeps> = {}
): Promise<VoiceSubmitResult> {
  const resolved: VoiceSubmitDeps = {
    stopRecording: deps.stopRecording ?? voiceRecorderStore.stop,
    transcribe: deps.transcribe ?? requestVoiceTranscription,
    putRecord: deps.putRecord ?? putVoiceRecord,
    deleteRecord: deps.deleteRecord ?? deleteVoiceRecord,
    isMounted: deps.isMounted ?? (() => true),
    currentSessionId: deps.currentSessionId ?? (() => input.sessionId),
    generateId: deps.generateId ?? generateUUID,
    now: deps.now ?? (() => Date.now()),
    delay: deps.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
  const ctx = await runVoiceSubmitPipeline({ ...input, deps: resolved });
  if (!('outcome' in ctx)) {
    return {
      kind: 'transcribe-failed',
      message: ctx.failure.message,
      attempts: ctx.failure.attempts,
      recordId: ctx.recordId,
      persisted: ctx.persisted,
    };
  }
  return {
    kind: 'routed',
    outcome: ctx.outcome,
    recordId: ctx.recordId,
    persisted: ctx.persisted,
    dequeued: ctx.dequeued,
  };
}
