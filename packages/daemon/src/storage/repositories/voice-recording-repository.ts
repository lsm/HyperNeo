import type { Database } from '../sqlite-compat.ts';
import type { VoiceTranscribeOutcome } from '../../lib/voice/transcribe-pipeline.ts';

export class VoiceRecordingRepository {
  constructor(private readonly db: Database) {}

  get(owner: string, id: string): { hash: string; outcome: VoiceTranscribeOutcome | null } | null {
    const row = this.db
      .prepare(
        'SELECT audio_sha256, outcome_json FROM voice_recordings WHERE owner = ? AND recording_id = ?'
      )
      .get(owner, id) as { audio_sha256: string; outcome_json: string | null } | null;
    return row
      ? {
          hash: row.audio_sha256,
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

  finish(owner: string, id: string, outcome: VoiceTranscribeOutcome): void {
    this.db
      .prepare(
        'UPDATE voice_recordings SET outcome_json = ?, completed_at = ? WHERE owner = ? AND recording_id = ? AND outcome_json IS NULL'
      )
      .run(JSON.stringify(outcome), Date.now(), owner, id);
  }
}
