import assert from 'node:assert/strict';
import { VoiceStream } from '../../src/lib/voice/stream-relay.ts';

const opened = await VoiceStream.start('synthetic-worker-exit', {
  voice: () => ({
    enabled: true,
    endpoint: 'https://93.184.216.34/v1/transcriptions',
    model: 'synthetic',
    mode: 'batch',
  }),
  transcribeWav: async (audio) => {
    assert.equal(Buffer.from(audio, 'base64').byteLength, 684);
    return { action: 'transcribed', text: 'decoded' };
  },
  push: () => {},
});
assert(!('error' in opened));
await opened.stream.enableOpus();
const audio = Uint8Array.from([3, 0, 0xf8, 0xff, 0xfe]);
assert.equal(await opened.stream.writeInput(() => audio, audio.byteLength, false), null);
assert.deepEqual(await opened.stream.stop(), { text: 'decoded', via: 'batch' });
console.log('batch-stop-complete');
