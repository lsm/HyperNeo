export type VoiceSubmitErrorClass = 'retry' | 'permanent' | 'discard';

export type VoiceSubmitMode = 'stay' | 'send' | 'queue';

export const VOICE_SUBMIT_RETRY_DELAY_MS = 5_000;
export const VOICE_SUBMIT_MAX_RETRY_DELAY_MS = 60_000;

const PERMANENT_SESSION_REFUSAL = /Session not found/;

const TRANSIENT_SUBMIT_ERROR =
  /rate limit exceeded|already in progress|timeout|timed out|fetch failed|request failed|not connected|abort/i;

const DISCARDED_SUBMIT_ERROR =
  /requires audio\/wav input|Audio data is (required|empty)|exceeds the 10 MB|must be valid base64|Voice input is disabled|(endpoint|model) is required|must be a valid URL|must use http:\/\/ or https:\/\/|redirected too many times|invalid redirect|redirect must use|cannot follow an HTTPS-to-HTTP redirect|response exceeds the 256 KB limit|private, loopback, or link-local|only sent over HTTPS/;

export function classifyVoiceSubmitError(error: unknown): VoiceSubmitErrorClass {
  if (error instanceof DOMException && error.name === 'AbortError') return 'retry';
  if (!(error instanceof Error)) return 'retry';
  if (PERMANENT_SESSION_REFUSAL.test(error.message)) return 'permanent';
  if (TRANSIENT_SUBMIT_ERROR.test(error.message)) return 'retry';
  if (DISCARDED_SUBMIT_ERROR.test(error.message)) return 'discard';
  return 'retry';
}

export function voiceRetryPolicy(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return VOICE_SUBMIT_RETRY_DELAY_MS;
  return Math.min(VOICE_SUBMIT_RETRY_DELAY_MS * 2 ** attempt, VOICE_SUBMIT_MAX_RETRY_DELAY_MS);
}

export interface VoiceSubmitRouteInput {
  transcript: string;
  mounted: boolean;
  sessionChanged: boolean;
  mode?: VoiceSubmitMode;
  composerFull?: boolean;
  deliveryRefused?: boolean;
}

export type VoiceSubmitOutcome =
  | { kind: 'insert'; transcript: string; autoSend: boolean }
  | { kind: 'deliver-unmounted'; transcript: string; mode: VoiceSubmitMode }
  | { kind: 'persist-for-resend'; transcript: string; reason: string }
  | { kind: 'discard-with-reason'; reason: string };

const DISCARD_SESSION_CHANGED = 'Recording target changed — transcript discarded';
const DISCARD_NO_SPEECH = 'No speech detected in that recording';
const PERSIST_COMPOSER_FULL =
  'Composer draft is full — voice transcript saved to the session draft';
const PERSIST_SEND_FAILED = 'Voice send failed — transcript saved to the session draft';

export function routeVoiceOutcome(input: VoiceSubmitRouteInput): VoiceSubmitOutcome {
  const { transcript, mounted, sessionChanged } = input;
  const mode = input.mode ?? 'stay';
  if (sessionChanged) {
    return { kind: 'discard-with-reason', reason: transcript ? DISCARD_SESSION_CHANGED : '' };
  }
  if (!transcript) {
    return { kind: 'discard-with-reason', reason: mounted ? DISCARD_NO_SPEECH : '' };
  }
  if (mounted) {
    return { kind: 'insert', transcript, autoSend: mode !== 'stay' };
  }
  if (mode !== 'stay') {
    if (input.composerFull) {
      return { kind: 'persist-for-resend', transcript, reason: PERSIST_COMPOSER_FULL };
    }
    if (input.deliveryRefused) {
      return { kind: 'persist-for-resend', transcript, reason: PERSIST_SEND_FAILED };
    }
  }
  return { kind: 'deliver-unmounted', transcript, mode };
}
