export type BodyBackupRequest = {
  id: number;
  action: 'backup' | 'checkpoint';
  dbPath: string;
  backupPath: string;
  mustExist?: boolean;
};
export type BodyBackupReply = {
  id: number;
  error?: string;
  backupPath?: string;
  hash?: string;
  rows?: number;
  elapsedMs?: number;
  backupBytes?: number;
  quickCheck?: 'ok';
  fileHash?: string;
};

export function sdkBodyBackupChannel(dbPath: string, backupPath: string, signal: AbortSignal) {
  const worker = new Worker(new URL('./sdk-message-body-backup-worker.ts', import.meta.url).href, {
    type: 'module',
  });
  let seq = 0;
  let fault: Error | undefined;
  const pending = new Map<
    number,
    { resolve: (reply: BodyBackupReply) => void; reject: (error: Error) => void }
  >();
  const stop = () => {
    worker.terminate();
    for (const call of pending.values()) call.reject(new Error('SDK body backup cancelled'));
    pending.clear();
  };
  signal.addEventListener('abort', stop, { once: true });
  worker.onmessage = (event: MessageEvent<BodyBackupReply>) => {
    const reply = event.data;
    const call = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) call?.reject(new Error(reply.error));
    else call?.resolve(reply);
  };
  worker.onerror = (error) => {
    fault = new Error(error.message);
    for (const call of pending.values()) call.reject(new Error(error.message));
    pending.clear();
  };
  const request = (action: BodyBackupRequest['action'], mustExist = false) =>
    new Promise<BodyBackupReply>((resolve, reject) => {
      if (fault) {
        reject(fault);
        return;
      }
      if (signal.aborted) {
        reject(new Error('SDK body backup cancelled'));
        return;
      }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, action, dbPath, backupPath, mustExist } satisfies BodyBackupRequest);
    });
  return {
    verify: (mustExist: boolean) => request('backup', mustExist),
    checkpoint: async () => {
      await request('checkpoint');
    },
    close: () => {
      signal.removeEventListener('abort', stop);
      stop();
    },
  };
}
