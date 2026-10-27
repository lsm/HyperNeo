import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { VoiceTranscribeOutcome } from '../../lib/voice/transcribe-pipeline.ts';

export class VoiceRecordingRepository {
  constructor(private readonly db: Database) {}

  getAsync(owner: string, id: string) {
    return gatewayFor(this.db).call(voiceRecordingReads, 'get', owner, id);
  }

  reserveAsync(owner: string, id: string, hash: string) {
    return gatewayFor(this.db).call(voiceRecordingWrites, 'reserve', owner, id, hash);
  }

  markDispatchedAsync(owner: string, id: string) {
    return gatewayFor(this.db).call(voiceRecordingWrites, 'markDispatched', owner, id);
  }

  releaseUnsentAsync(owner: string, id: string) {
    return gatewayFor(this.db).call(voiceRecordingWrites, 'releaseUnsent', owner, id);
  }

  releaseUnsent(owner: string, id: string): void {
    this.db
      .prepare(
        'UPDATE voice_recordings SET dispatched_at = NULL WHERE owner = ? AND recording_id = ?'
      )
      .run(owner, id);
  }

  finishAsync(owner: string, id: string, outcome: VoiceTranscribeOutcome, dispatched: boolean) {
    return gatewayFor(this.db).call(voiceRecordingWrites, 'finish', owner, id, outcome, dispatched);
  }

  get(
    owner: string,
    id: string
  ): { hash: string; outcome: VoiceTranscribeOutcome | null; dispatched: boolean } | null {
    const row = this.db
      .prepare(
        'SELECT audio_sha256, outcome_json, dispatched_at FROM voice_recordings WHERE owner = ? AND recording_id = ?'
      )
      .get(owner, id) as {
      audio_sha256: string;
      outcome_json: string | null;
      dispatched_at: number | null;
    } | null;
    return row
      ? {
          hash: row.audio_sha256,
          dispatched: row.dispatched_at !== null,
          outcome: row.outcome_json
            ? (JSON.parse(row.outcome_json) as VoiceTranscribeOutcome)
            : null,
        }
      : null;
  }

  reserve(owner: string, id: string, hash: string): boolean {
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO voice_recordings (owner, recording_id, audio_sha256, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(owner, id, hash, Date.now()).changes === 1
    );
  }

  markDispatched(owner: string, id: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE voice_recordings SET dispatched_at = ?, outcome_json = NULL, completed_at = NULL WHERE owner = ? AND recording_id = ? AND dispatched_at IS NULL'
        )
        .run(Date.now(), owner, id).changes === 1
    );
  }

  finish(owner: string, id: string, outcome: VoiceTranscribeOutcome, dispatched: boolean): void {
    this.db
      .prepare(
        'UPDATE voice_recordings SET outcome_json = ?, completed_at = ? WHERE owner = ? AND recording_id = ? AND (dispatched_at IS NOT NULL) = ?'
      )
      .run(JSON.stringify(outcome), Date.now(), owner, id, Number(dispatched));
  }
}

export const voiceRecordingReads = defineRepositoryOp(
  'voice.recording.read',
  'read',
  VoiceRecordingRepository,
  ['get'] as const
);
export const voiceRecordingWrites = defineRepositoryOp(
  'voice.recording.write',
  'write',
  VoiceRecordingRepository,
  ['reserve', 'markDispatched', 'releaseUnsent', 'finish'] as const
);
