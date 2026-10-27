import { startAsrCore, type AsrRelayEvent, type AsrRelayOpen } from './asr-relay-core.ts';

type Command =
  | { type: 'open'; open: AsrRelayOpen }
  | { type: 'audio'; pcm: Uint8Array }
  | { type: 'finish' }
  | { type: 'close'; initiator: 'client' | 'relay' }
  | { type: 'abort-late-open' };

const worker = globalThis as unknown as {
  onmessage: (event: { data: Command }) => void;
  postMessage(message: AsrRelayEvent): void;
};

let core: ReturnType<typeof startAsrCore> | null = null;

worker.onmessage = ({ data }) => {
  if (data.type === 'open') core = startAsrCore(data.open, (event) => worker.postMessage(event));
  else if (data.type === 'audio') core?.audio(data.pcm);
  else if (data.type === 'finish') core?.finish();
  else if (data.type === 'close') core?.close(data.initiator);
  else if (data.type === 'abort-late-open') core?.abortLateOpen();
};
