import { emitStructuredLogEvent } from './logger';

const FLUSH_TIMEOUT_MS = 2000;

export interface ProcessFatalLoggingOptions {
  flush?: () => Promise<void>;
  exit?: (code: number) => void;
}

type FatalProcessEvent = 'uncaughtException' | 'unhandledRejection';

export function installProcessFatalLogging(options: ProcessFatalLoggingOptions = {}): () => void {
  const flush = options.flush ?? (() => Promise.resolve());
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let handling = false;

  const handle = (processEvent: FatalProcessEvent, reason: unknown): void => {
    if (handling) return;
    handling = true;
    try {
      emitStructuredLogEvent({
        level: 'fatal',
        args: [
          `[Daemon] Process fatal event (${processEvent}), exiting:`,
          reason instanceof Error ? reason : String(reason),
        ],
        source: 'process',
        module: 'daemon:process',
        metadata: { processEvent },
      });
    } catch {}
    const finish = () => {
      try {
        exit(1);
      } catch {}
    };
    Promise.race([flush(), new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))])
      .catch(() => {})
      .then(finish);
  };

  const onUncaught = (error: Error) => handle('uncaughtException', error);
  const onRejection = (reason: unknown) => handle('unhandledRejection', reason);

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return () => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  };
}
