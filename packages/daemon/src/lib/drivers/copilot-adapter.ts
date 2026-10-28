import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { CopilotModelUnavailableError, openCopilotWorker } from './copilot-worker.ts';
import { selectLocalStartFolder, type StartFolderDeps } from './start-folder.ts';
import { workStartPreparation } from './start-preparation.ts';
import { reject } from './work-operations.ts';
import { errorMessage } from '../utils/error-message.ts';
import { copilotOwnsSession, createCopilotFind } from './copilot-find.ts';
import { readCopilotHistory } from './copilot-history.ts';
import type * as W from './types.ts';

type Receipt = W.WorkStarted['receipt'];
type Worker = Awaited<ReturnType<typeof openCopilotWorker>>;
type Snapshot = Awaited<ReturnType<Worker['snapshot']>>;
type Record = {
  work: W.WorkStarted;
  snapshot: Snapshot;
  directory: string;
  pendingSubmission?: boolean;
  latestReceipt?: Receipt;
};
type Gate<T> = { value: T } | { reason: ReturnType<typeof reject> };
interface Deps extends StartFolderDeps {
  cliPath: string;
  directory: string;
  machine: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  projectFolder?: (folder: string) => string | Promise<string>;
}

export function createCopilotAdapter(
  discovery: W.WorkAdapter,
  deps: Deps
): W.WorkAdapter & { close: () => Promise<void> } {
  const live = new Map<string, Worker>();
  const transactions = new Map<string, Promise<unknown>>();
  const starts = new Set<Promise<W.Result<W.WorkStarted>>>();
  const launching = new Set<string>();
  let closed = false;
  const path = (id: string) => join(deps.directory, `${id}.json`);
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const save = (record: Record) => write(path(record.work.ref.id), record);
  const inputPath = (id: string, input: string) =>
    join(deps.directory, 'receipts', id, `${encodeURIComponent(input)}.json`);
  const open = async (record: Record, resume = false) => {
    if (resume)
      for (const [id, input] of Object.entries(record.snapshot.inputs))
        if (!fs.existsSync(inputPath(record.work.ref.id, id)))
          write(inputPath(record.work.ref.id, id), input);
    const worker = await openCopilotWorker({
      cliPath: deps.cliPath,
      expectedVersion: '1.0.83',
      sessionId: record.work.ref.id,
      cwd: record.directory,
      stateDirectory: join(deps.directory, record.work.ref.id),
      model: record.work.model!,
      env: deps.env,
      timeoutMs: deps.timeoutMs,
      resume,
      onInput: (id, input) => write(inputPath(record.work.ref.id, id), input),
    });
    live.set(record.work.ref.id, worker);
    return worker;
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
  const prepare = (folder: string): Gate<{ id: string; directory: string }> => {
    const directory = fs.realpathSync(folder);
    return fs.statSync(directory).isDirectory()
      ? { value: { id: crypto.randomUUID(), directory } }
      : { reason: reject('invalid_place', 'Copilot execution needs a directory.') };
  };
  const launchOwned = async (
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
      worker = await open(record);
      record.work.receipt = await worker.submit(request.message);
      record.snapshot = await worker.snapshot();
      if (record.snapshot.status === 'unreachable')
        throw new Error('Copilot disconnected after accepting input.');
      record.work.status = record.snapshot.status;
      save(record);
      void worker.terminal.then(() => guard(() => status(record.work.ref), location.id));
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
  const launch = async (location: { id: string; directory: string }, request: W.StartRequest) => {
    launching.add(location.id);
    try {
      return await launchOwned(location, request);
    } finally {
      launching.delete(location.id);
    }
  };
  const selectFolder = (request: W.StartRequest) =>
    selectLocalStartFolder(request, deps, 'Copilot needs a local folder.');
  const start = (superpipe({})('copilot-start') as PipelineAPI)
    .input(['request'])
    .pipe(admit, 'request', 'result:started')
    .pipe(selectFolder, 'started', 'result:started')
    .pipe(prepare, 'started', 'result:started')
    .pipe(launch, ['started', 'request'], 'started')
    .endAsync('started') as (request: W.StartRequest) => Promise<W.Result<W.WorkStarted>>;
  const refresh = async (record: Record) => {
    const owned = !closed && !launching.has(record.work.ref.id) && live.get(record.work.ref.id);
    if (owned) {
      record.snapshot = await owned.snapshot();
      save(record);
      if (['done', 'failed', 'stopped', 'unreachable'].includes(record.snapshot.status)) {
        live.delete(record.work.ref.id);
        await owned.close();
      }
    }
    return record;
  };
  const detail = (record: Record, receipt?: Receipt): W.Result<W.WorkDetail> => {
    if (record.pendingSubmission && !receipt) return unavailable();
    receipt ??= record.latestReceipt ?? record.work.receipt;
    const { work, snapshot } = record;
    if (receipt && receipt.executionId !== work.ref.id)
      return reject('not_found', 'Receipt does not belong to this owned input.');
    let input =
      receipt && Object.hasOwn(snapshot.inputs, receipt.inputId)
        ? snapshot.inputs[receipt.inputId]
        : undefined;
    if (receipt) {
      try {
        input = JSON.parse(fs.readFileSync(inputPath(work.ref.id, receipt.inputId), 'utf8'));
      } catch {}
      if (!input) return reject('not_found', 'Receipt does not belong to this owned input.');
    }
    if (
      !input?.outcome &&
      (snapshot.status === 'unreachable' ||
        (!live.has(work.ref.id) && !['done', 'failed', 'stopped'].includes(snapshot.status)))
    )
      return unavailable();
    return {
      ok: true,
      value: {
        ...work,
        status:
          snapshot.status === 'unreachable' || (!live.has(work.ref.id) && input?.outcome)
            ? input!.outcome!
            : snapshot.status,
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
  const admitSend = (record: Record): Gate<Record> => {
    if (closed || record.pendingSubmission || record.snapshot.status === 'unreachable')
      return { reason: unavailable() };
    if (record.snapshot.status === 'needs_you')
      return { reason: reject('busy', 'Copilot is awaiting permission; follow-up refused.') };
    if (
      !live.has(record.work.ref.id) &&
      !['done', 'failed', 'stopped'].includes(record.snapshot.status)
    )
      return { reason: unavailable() };
    if (Object.values(record.snapshot.inputs).filter((input) => !input.outcome).length >= 64)
      return { reason: reject('busy', 'Copilot has 64 unsettled inputs.') };
    return { value: record };
  };
  const deliver = async (record: Record, message: string): Promise<W.Result<W.WorkDelivery>> => {
    const id = record.work.ref.id;
    let owned = live.get(id);
    const resumed = !owned;
    let submitAttempted = false;
    try {
      owned ??= await open(record, true);
      record.pendingSubmission = true;
      save(record);
      submitAttempted = true;
      const receipt = await owned.submit(message);
      record.snapshot = await owned.snapshot();
      if (record.snapshot.status === 'unreachable') throw new Error('Copilot lost after input ACK');
      delete record.pendingSubmission;
      record.latestReceipt = receipt;
      record.work.lastActivityAt = Date.now();
      save(record);
      if (resumed) void owned.terminal.then(() => guard(() => status(record.work.ref), id));
      const observed = record.snapshot.inputs[receipt.inputId]?.state === 'observed';
      return {
        ok: true,
        value: {
          delivered: observed,
          receipt,
          ...(!observed ? { queuedSubmissionId: receipt.inputId } : {}),
        },
      };
    } catch (error) {
      live.delete(id);
      try {
        if (record.pendingSubmission) {
          record.snapshot.status = 'unreachable';
          save(record);
        }
      } finally {
        await owned?.close();
      }
      if (error instanceof CopilotModelUnavailableError && error.cause === undefined)
        return reject('unsupported_model', error.message);
      return reject(
        'unreachable',
        errorMessage(error) + (submitAttempted ? '; input may be accepted; do not replay.' : '')
      );
    }
  };
  const send = (superpipe({})('copilot-send') as PipelineAPI)
    .input(['ref', 'message'])
    .pipe(lookup, 'ref', 'result:delivery')
    .pipe(refresh, 'delivery', 'delivery')
    .pipe(admitSend, 'delivery', 'result:delivery')
    .pipe(deliver, ['delivery', 'message'], 'delivery')
    .endAsync('delivery') as (ref: W.WorkRef, message: string) => Promise<W.Result<W.WorkDelivery>>;
  const admitRename = (record: Record, title: string): Gate<Record> => {
    if (title.length > 100)
      return {
        reason: reject('not_delivered', 'Copilot session names are 1–100 characters.', true),
      };
    if (launching.has(record.work.ref.id))
      return {
        reason: reject('busy', 'Copilot work is still starting; rename after work.start.', true),
      };
    if (closed || record.pendingSubmission || record.snapshot.status === 'unreachable')
      return { reason: unavailable() };
    if (
      !live.has(record.work.ref.id) &&
      !['done', 'failed', 'stopped'].includes(record.snapshot.status)
    )
      return { reason: unavailable() };
    return { value: record };
  };
  const applyRename = async (record: Record, title: string): Promise<W.Result<W.WorkRenamed>> => {
    const id = record.work.ref.id;
    let owned = live.get(id);
    const resumed = !owned;
    try {
      owned ??= await open(record, true);
      await owned.rename(title);
      record.work.title = title;
      save(record);
      return { ok: true, value: { renamed: true, title } };
    } finally {
      if (resumed) {
        live.delete(id);
        await owned?.close();
      }
    }
  };
  const rename = (superpipe({})('copilot-rename') as PipelineAPI)
    .input(['ref', 'title'])
    .pipe(lookup, 'ref', 'result:renamed')
    .pipe(refresh, 'renamed', 'renamed')
    .pipe(admitRename, ['renamed', 'title'], 'result:renamed')
    .pipe(applyRename, ['renamed', 'title'], 'renamed')
    .endAsync('renamed') as (ref: W.WorkRef, title: string) => Promise<W.Result<W.WorkRenamed>>;
  const stop = (superpipe({})('copilot-stop') as PipelineAPI)
    .input(['ref'])
    .pipe(lookup, 'ref', 'result:stopped')
    .pipe(refresh, 'stopped', 'stopped')
    .pipe(
      async (record: Record): Promise<W.Result<{ stopped: boolean }>> => {
        if (['done', 'failed', 'stopped'].includes(record.snapshot.status))
          return { ok: true, value: { stopped: false } };
        if (closed) return unavailable();
        const id = record.work.ref.id;
        const owned = live.get(id);
        if (!owned) return unavailable();
        try {
          await owned.abort();
          const until = Date.now() + (deps.timeoutMs ?? 10_000);
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
  const find = createCopilotFind(
    discovery,
    deps.directory,
    (id) => copilotOwnsSession(deps.directory, id),
    async (id) => {
      const result = await guard(async () => {
        const loaded = lookup({ adapter: discovery.id, id });
        if ('reason' in loaded) return loaded.reason;
        const record = loaded.value;
        const owner = closed ? undefined : live.get(id);
        const status = owner?.peekStatus() ?? record.snapshot.status;
        const folder =
          (await deps.projectFolder?.(record.directory)) ??
          record.work.place.folder ??
          record.directory;
        const unavailable =
          status === 'unreachable' || (!owner && !['done', 'failed', 'stopped'].includes(status));
        return {
          ok: true,
          value: {
            ...record.work,
            place: { ...record.work.place, folder, name: basename(folder) || folder },
            status:
              status === 'unreachable'
                ? record.pendingSubmission
                  ? 'queued'
                  : record.work.status
                : status,
            ...(unavailable
              ? {
                  watchHint:
                    'Copilot owner unavailable; status is last known. Read stored history with work.read; do not replay uncertain input.',
                }
              : {}),
          },
        };
      }, id);
      return result.ok ? result.value : undefined;
    }
  );
  return {
    ...discovery,
    find,
    readTurns: (id, around, before, after, cursor) => {
      if (!copilotOwnsSession(deps.directory, id)) return null;
      return readCopilotHistory(
        join(deps.directory, id, 'session-state', id, 'events.jsonl'),
        id,
        around,
        before,
        after,
        cursor
      );
    },
    capabilities: ['find', 'start', 'rename', 'send', 'queue', 'status', 'stop'] as const,
    unsupportedCapabilities: {
      steer:
        'Copilot strict same-turn steering is unsupported: immediate input can fall back to a later turn; the pinned protocol has no expected-active-turn precondition. Use auto or queue for explicit enqueue delivery.',
    },
    start: (request: W.StartRequest) => {
      const pending = guard(() => start(request));
      starts.add(pending);
      void pending.finally(() => starts.delete(pending));
      return pending;
    },
    rename: (ref, title) => guard(() => rename(ref, title), ref.id),
    send: (ref, message) => guard(() => send(ref, message), ref.id),
    queue: (ref, message) => guard(() => send(ref, message), ref.id),
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
