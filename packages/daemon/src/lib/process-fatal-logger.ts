import { emitStructuredLogEvent, withConsoleLogCaptureSuppressed } from './logger.ts';

const FLUSH_TIMEOUT_MS = 2000;

export interface ProcessFatalLoggingOptions {
  flush?: () => Promise<void>;
  exit?: (code: number) => void;
}

type FatalProcessEvent = 'uncaughtException' | 'unhandledRejection';

interface FatalRegistration {
  flush: () => Promise<void>;
  exit: (code: number) => void;
}

const DEFAULT_REGISTRATION: FatalRegistration = {
  flush: () => Promise.resolve(),
  exit: (code: number) => process.exit(code),
};

const registrations: FatalRegistration[] = [];
let handling = false;

function activeRegistration(): FatalRegistration {
  return registrations.length > 0 ? registrations[registrations.length - 1] : DEFAULT_REGISTRATION;
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return String(reason);
}

function handle(processEvent: FatalProcessEvent, reason: unknown): void {
  if (handling) return;
  handling = true;
  const registration = activeRegistration();
  try {
    emitStructuredLogEvent({
      level: 'fatal',
      args: [`[Daemon] Process fatal event (${processEvent}), exiting:`, reason],
      source: 'process',
      module: 'daemon:process',
      metadata: { processEvent },
    });
  } catch {}
  try {
    withConsoleLogCaptureSuppressed(() => {
      process.stderr.write(`[Fatal] ${processEvent}: ${describeReason(reason)}\n`);
    });
  } catch {}
  const finish = () => {
    try {
      registration.exit(1);
    } catch {}
  };
  Promise.race([
    registration.flush(),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
  ])
    .catch(() => {})
    .then(finish);
}

const onUncaught = (error: Error) => handle('uncaughtException', error);
const onRejection = (reason: unknown) => handle('unhandledRejection', reason);

export function installProcessFatalLogging(options: ProcessFatalLoggingOptions = {}): () => void {
  const registration: FatalRegistration = {
    flush: options.flush ?? DEFAULT_REGISTRATION.flush,
    exit: options.exit ?? DEFAULT_REGISTRATION.exit,
  };
  if (registrations.length === 0) {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
  }
  registrations.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
    if (registrations.length === 0) {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
      handling = false;
    }
  };
}
