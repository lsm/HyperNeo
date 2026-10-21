import * as fs from 'node:fs';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { CopilotModelUnavailableError, openCopilotWorker } from './copilot-worker.ts';
import { selectLocalStartFolder, type StartFolderDeps } from './start-folder.ts';
import { workStartPreparation } from './start-preparation.ts';
import { reject } from './work-operations.ts';
import { errorMessage } from '../utils/error-message.ts';
import type * as W from './types.ts';

type Receipt = W.WorkStarted['receipt'];
type Worker = Awaited<ReturnType<typeof openCopilotWorker>>;
type Snapshot = Awaited<ReturnType<Worker['snapshot']>>;
type Record = { work: W.WorkStarted; snapshot: Snapshot; directory: string };
type Gate<T> = { value: T } | { reason: ReturnType<typeof reject> };
interface Deps extends StartFolderDeps {
  cliPath: string;
  directory: string;
  machine: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function createCopilotAdapter(
  discovery: W.WorkAdapter,
  deps: Deps
): W.WorkAdapter & { close: () => Promise<void> } {
  const live = new Map<string, Worker>();
  const transactions = new Map<string, Promise<unknown>>();
  const starts = new Set<Promise<W.Result<W.WorkStarted>>>();
  let closed = false;
  const path = (id: string) => join(deps.directory, `${id}.json`);
  const save = (record: Record) => {
    fs.mkdirSync(deps.directory, { recursive: true, mode: 0o700 });
    const file = path(record.work.ref.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const lookup = (ref: W.WorkRef): Gate<Record> => {
    if (!/^[0-9a-f-]{36}$/.test(ref.id))
      return { reason: reject('not_found', 'Not an owned Copilot session.') };
    try {
      return { value: JSON.parse(fs.readFileSync(path(ref.id), 'utf8')) };
    } catch {
      return { reason: reject('not_found', 'Not an owned Copilot session.') };
    }
  };
  const unavailable = () => reject('unreachable', 'No live Copilot owner; do not replay.');
  const guard = <T>(effect: () => Promise<W.Result<T>>, id?: string) => {
    const previous = id ? transactions.get(id) : undefined;
    const pending = (previous ?? Promise.resolve())
      .then(effect)
      .catch((error: unknown) => reject('unreachable', errorMessage(error)));
    if (id) {
      transactions.set(id, pending);
      void pending.then(() => {
        if (transactions.get(id) === pending) transactions.delete(id);
      });
    }
    return pending;
  };
  const admit = (request: W.StartRequest): Gate<W.StartRequest> => {
    if (closed) return { reason: reject('unreachable', 'Copilot owner is shutting down.') };
    if (request.effort !== undefined)
      return { reason: reject('unsupported_effort', 'Copilot effort is not wired yet.') };
    if (!request.model)
      return { reason: reject('unsupported_model', 'Choose an explicit Copilot model ID.') };
    const preparation = workStartPreparation.admit(request.preparation, false);
    return 'reason' in preparation ? preparation : { value: request };
  };
  const prepare = (folder: string) => {
    const directory = fs.realpathSync(folder);
    if (!fs.statSync(directory).isDirectory())
      throw new Error('Copilot execution needs a directory.');
    return { id: crypto.randomUUID(), directory };
  };
  const launch = async (
    location: { id: string; directory: string },
    request: W.StartRequest
  ): Promise<W.Result<W.WorkStarted>> => {
    const record: Record = {
      work: {
        ref: { adapter: discovery.id, id: location.id },
        title: request.title,
        place: { ...request.place, machine: deps.machine },
        status: 'queued',
        lastActivityAt: Date.now(),
        model: request.model,
        watchHint: 'Watch with work.status; app visibility is unverified.',
      },
      snapshot: { status: 'queued', inputs: {} },
      directory: location.directory,
    };
    let worker: Worker | undefined;
    try {
      save(record);
      worker = await openCopilotWorker({
        cliPath: deps.cliPath,
        expectedVersion: '1.0.83',
        sessionId: location.id,
        cwd: location.directory,
        stateDirectory: join(deps.directory, location.id),
        model: request.model!,
        env: deps.env,
        timeoutMs: deps.timeoutMs,
      });
      live.set(location.id, worker);
      record.work.receipt = await worker.submit(request.message);
      record.snapshot = await worker.snapshot();
      if (record.snapshot.status === 'unreachable')
        throw new Error('Copilot disconnected after accepting input.');
      record.work.status = record.snapshot.status;
      save(record);
      return { ok: true, value: record.work };
    } catch (error) {
      const failures = [error];
      record.snapshot.status = 'unreachable';
      try {
        save(record);
      } catch (failure) {
        failures.push(failure);
      }
      await worker?.close().catch((failure) => failures.push(failure));
      live.delete(location.id);
      if (error instanceof CopilotModelUnavailableError && error.cause === undefined)
        return reject('unsupported_model', error.message);
      return reject(
        'unreachable',
        `copilot-cli:${location.id}: ${failures.map(String).join('; ')}. Check work.status; do not replay this start automatically.`
      );
    }
  };
  const selectFolder = (request: W.StartRequest) =>
    selectLocalStartFolder(request, deps, 'Copilot needs a local folder.');
  const start = (superpipe({})('copilot-start') as PipelineAPI)
    .input(['request'])
    .pipe(admit, 'request', 'result:started')
    .pipe(selectFolder, 'started', 'result:started')
    .pipe(prepare, 'started', 'location')
    .pipe(launch, ['location', 'request'], 'started')
    .endAsync('started') as (request: W.StartRequest) => Promise<W.Result<W.WorkStarted>>;
  const refresh = async (record: Record) => {
    const owned = !closed && live.get(record.work.ref.id);
    if (owned) {
      record.snapshot = await owned.snapshot();
      save(record);
    }
    return record;
  };
  const detail = (record: Record, receipt = record.work.receipt): W.Result<W.WorkDetail> => {
    const { work, snapshot } = record;
    if (
      receipt &&
      (receipt.executionId !== work.ref.id || !Object.hasOwn(snapshot.inputs, receipt.inputId))
    )
      return reject('not_found', 'Receipt does not belong to this owned input.');
    if (
      snapshot.status === 'unreachable' ||
      (!live.has(work.ref.id) && !['done', 'failed', 'stopped'].includes(snapshot.status))
    )
      return unavailable();
    const input = receipt ? snapshot.inputs[receipt.inputId] : undefined;
    return {
      ok: true,
      value: {
        ...work,
        status: snapshot.status,
        startReceipt: work.receipt,
        execution: { directory: record.directory, machine: deps.machine },
        ...(input?.replyReport ? { lastReply: input.replyReport } : {}),
        inputEvidence:
          receipt && input
            ? input.state === 'pending'
              ? { receipt, state: 'pending' }
              : {
                  receipt,
                  state: 'observed',
                  exchange: [],
                  exchangeCut: true,
                  replyReport: input.replyReport,
                  replyAvailability: input.replyAvailability,
                }
            : undefined,
        waitingFor: snapshot.status === 'needs_you' ? 'Permission denied.' : undefined,
      },
    };
  };
  const status = (superpipe({})('copilot-status') as PipelineAPI)
    .input(['ref', 'receipt'])
    .pipe(lookup, 'ref', 'result:detail')
    .pipe(refresh, 'detail', 'record')
    .pipe(detail, ['record', 'receipt'], 'detail')
    .endAsync('detail') as (ref: W.WorkRef, receipt?: Receipt) => Promise<W.Result<W.WorkDetail>>;
  const stop = (superpipe({})('copilot-stop') as PipelineAPI)
    .input(['ref'])
    .pipe(lookup, 'ref', 'result:stopped')
    .pipe(
      async (record: Record): Promise<W.Result<{ stopped: boolean }>> => {
        if (closed) return unavailable();
        const id = record.work.ref.id;
        const owned = live.get(id);
        if (!owned)
          return record.snapshot.status === 'stopped'
            ? { ok: true, value: { stopped: true } }
            : unavailable();
        try {
          await owned.abort();
          const until = Date.now() + (deps.timeoutMs ?? 2000);
          do {
            record.snapshot = await owned.snapshot();
            if (record.snapshot.status === 'stopped' || record.snapshot.status === 'unreachable')
              break;
            await new Promise((done) => setTimeout(done, 20));
          } while (Date.now() < until);
          if (record.snapshot.status !== 'stopped') {
            record.snapshot.status = 'unreachable';
            return reject(
              'unreachable',
              'Abort unconfirmed; runtime closed, tool termination unknown.'
            );
          }
          return { ok: true, value: { stopped: true } };
        } finally {
          live.delete(id);
          try {
            save(record);
          } finally {
            await owned.close();
          }
        }
      },
      'stopped',
      'stopped'
    )
    .endAsync('stopped') as (ref: W.WorkRef) => Promise<W.Result<{ stopped: boolean }>>;
  return {
    ...discovery,
    capabilities: ['find', 'start', 'status', 'stop'] as const,
    start: (request: W.StartRequest) => {
      const pending = guard(() => start(request));
      starts.add(pending);
      void pending.finally(() => starts.delete(pending));
      return pending;
    },
    status: (ref, _since, receipt) => guard(() => status(ref, receipt), ref.id),
    stop: (ref) => guard(() => stop(ref), ref.id),
    async close() {
      closed = true;
      await Promise.allSettled([...starts, ...transactions.values()]);
      const closing = [...live.values()];
      live.clear();
      const results = await Promise.allSettled(closing.map((owned) => owned.close()));
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Copilot cleanup failed');
    },
  };
}
