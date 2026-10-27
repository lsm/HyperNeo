import { startAsrCore, type AsrRelayEvent, type AsrRelayOpen } from './asr-relay-core.ts';
import { runtimeWorkerUrl } from '../runtime-worker-url.ts';

export type { AsrRelayEvent } from './asr-relay-core.ts';

export type AsrRelayCommand =
  | { type: 'audio'; pcm: Uint8Array }
  | { type: 'finish' }
  | { type: 'close'; initiator: 'client' | 'relay' }
  | { type: 'abort-late-open' };

export interface AsrRelay {
  post(command: AsrRelayCommand): void;
  onMessage(handler: (event: AsrRelayEvent) => void): void;
  close(): void;
}

export type AsrRelayFactory = (open: AsrRelayOpen) => AsrRelay;

export const asrRelayDefaults: { create: AsrRelayFactory } = { create: createThreadedAsrRelay };

export function createInThreadAsrRelay(open: AsrRelayOpen): AsrRelay {
  let handler: ((event: AsrRelayEvent) => void) | null = null;
  const queued: AsrRelayEvent[] = [];
  const core = startAsrCore(open, (event) => {
    if (handler) handler(event);
    else queued.push(event);
  });
  return {
    post: (command) => {
      if (command.type === 'audio') core.audio(command.pcm);
      else if (command.type === 'finish') core.finish();
      else if (command.type === 'close') core.close(command.initiator);
      else core.abortLateOpen();
    },
    onMessage: (listener) => {
      handler = listener;
      for (const event of queued.splice(0)) listener(event);
    },
    close: () => {
      handler = null;
      core.close('relay');
    },
  };
}

export function createThreadedAsrRelay(open: AsrRelayOpen): AsrRelay {
  let handler: ((event: AsrRelayEvent) => void) | null = null;
  const worker = new Worker(
    runtimeWorkerUrl(
      './stream-relay-worker.ts',
      './daemon/src/lib/voice/stream-relay-worker.ts',
      import.meta.url
    ).toString(),
    { type: 'module' }
  );
  worker.onmessage = (event: MessageEvent) => handler?.(event.data as AsrRelayEvent);
  worker.onerror = () => {
    handler?.({ type: 'open_failed', reason: 'relay worker failed' });
    handler?.({ type: 'dead' });
  };
  (worker as Worker & { onexit?: (exitCode: number) => void }).onexit = () => {
    handler?.({ type: 'dead' });
  };
  worker.postMessage({ type: 'open', open });
  return {
    post: (command) => {
      worker.postMessage(command);
    },
    onMessage: (listener) => {
      handler = listener;
    },
    close: () => {
      handler = null;
      worker.terminate();
    },
  };
}
