import { createHash } from 'node:crypto';
import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { VoiceRecordingRepository } from '../../storage/repositories/voice-recording-repository.ts';
import type { VoiceTranscribeOutcome } from './transcribe-pipeline.ts';

type Recording = { owner: string; id: string; hash: string };
type Submit = (beforeDispatch: () => void) => Promise<VoiceTranscribeOutcome>;
type Request = { recordingId?: string; audioBase64: string; mimeType: string };

export class VoiceRecordingTranscription {
  private readonly active = new Map<string, Promise<VoiceTranscribeOutcome>>();

  constructor(private readonly repository: VoiceRecordingRepository) {}

  run(recording: Recording, submit: Submit): Promise<VoiceTranscribeOutcome> {
    const { owner, id, hash } = recording;
    const key = JSON.stringify([owner, id]);
    const saved = this.repository.get(owner, id);
    if (saved && saved.hash !== hash)
      return Promise.resolve({
        action: 'denied',
        message:
          'recordingId already belongs to different audio; keep the original recording id for identical retries only',
      });
    const running = this.active.get(key);
    if (running) return running;
    if (saved?.dispatched)
      return Promise.resolve(
        saved.outcome ?? {
          action: 'failed',
          error:
            'Recording submission is unconfirmed after interruption; it will not be submitted again automatically',
        }
      );
    if (!saved && !this.repository.reserve(owner, id, hash)) return this.run(recording, submit);
    let dispatched = false;
    const beforeDispatch = () => {
      if (dispatched) return;
      if (!this.repository.markDispatched(owner, id))
        throw new Error('Recording submission is already dispatched; retry for its saved result');
      dispatched = true;
    };
    const pending = Promise.resolve()
      .then(() => submit(beforeDispatch))
      .catch(
        (error: unknown): VoiceTranscribeOutcome => ({
          action: 'failed',
          error: error instanceof Error ? error.message : 'Voice transcription failed',
        })
      )
      .then((outcome) => {
        this.repository.finish(owner, id, outcome, dispatched);
        return outcome;
      })
      .finally(() => this.active.delete(key));
    this.active.set(key, pending);
    return pending;
  }
}

function prepareRecording(
  data: Request,
  owner: string,
  service: VoiceRecordingTranscription | undefined
): { value: { recording: Recording; service: VoiceRecordingTranscription } } | { reason: string } {
  if (!service) return { reason: 'Recording retry storage is unavailable' };
  if (
    typeof data.recordingId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.recordingId)
  )
    return { reason: 'recordingId must be a UUID retained across retries' };
  if (
    data.mimeType !== 'audio/wav' ||
    typeof data.audioBase64 !== 'string' ||
    !data.audioBase64 ||
    data.audioBase64.length > Math.ceil(VOICE_MAX_AUDIO_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audioBase64) ||
    data.audioBase64.length % 4 !== 0
  )
    return { reason: 'Voice recording requires valid base64 audio/wav within the 10 MB limit' };
  const hash = createHash('sha256').update(Buffer.from(data.audioBase64, 'base64')).digest('hex');
  return { value: { recording: { owner, id: data.recordingId.toLowerCase(), hash }, service } };
}

const recordedVoice = (superpipe({})('voice-recording-transcribe') as PipelineAPI)
  .input(['data', 'owner', 'service', 'submit'])
  .pipe(prepareRecording, ['data', 'owner', 'service'], 'result:outcome')
  .pipe(
    (prepared: { recording: Recording; service: VoiceRecordingTranscription }, submit: Submit) =>
      prepared.service.run(prepared.recording, submit),
    ['outcome', 'submit'],
    'outcome'
  )
  .endAsync('outcome') as (
  data: Request,
  owner: string,
  service: VoiceRecordingTranscription | undefined,
  submit: Submit
) => Promise<VoiceTranscribeOutcome | string>;

export async function runRecordedVoice(
  data: Request,
  owner: string,
  service: VoiceRecordingTranscription | undefined,
  submit: Submit
): Promise<VoiceTranscribeOutcome> {
  const result = await recordedVoice(data, owner, service, submit);
  return typeof result === 'string' ? { action: 'denied', message: result } : result;
}
