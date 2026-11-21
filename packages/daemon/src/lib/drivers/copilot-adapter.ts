import { prepareWorkerFolder, cleanupOwnedWorktree, type GitCheckout } from './work-placement.ts';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';
import { workExecutionLocation } from './execution-location.ts';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  COPILOT_CLI_VERSION,
  CopilotEffortUnavailableError,
  CopilotModelUnavailableError,
  openCopilotWorker,
} from './copilot-worker.ts';
import { selectLocalStartFolder, type StartFolderDeps } from './start-folder.ts';
import { workStartPreparation } from './start-preparation.ts';
import { workStartConfiguration } from './start-configuration.ts';
import { reject } from './work-operations.ts';
import { errorMessage } from '../utils/error-message.ts';
import { copilotOwnsSession, createCopilotFind } from './copilot-find.ts';
import { readCopilotObservations, readCopilotTurnFacts } from './copilot-observations.ts';
import { readCopilotHistory, createCopilotInputReader } from './copilot-history.ts';
import type * as W from './types.ts';

type Receipt = W.WorkStarted['receipt'];
type Worker = Awaited<ReturnType<typeof openCopilotWorker>>;
type InputMode = NonNullable<Parameters<Worker['submit']>[1]>;
type Snapshot = Awaited<ReturnType<Worker['snapshot']>>;
type Record = {
  work: W.WorkStarted;
  snapshot: Snapshot;
  directory: string;
  pendingSubmission?: boolean;
  latestReceipt?: Receipt;
  archived?: boolean;
};
type Gate<T> = { value: T } | { reason: ReturnType<typeof reject> };
interface Deps extends StartFolderDeps {
  resolveCliPath: () => Promise<string>;
  directory: string;
  machine: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  worktreesDir?: string;
  gitCheckout?: (folder: string) => Promise<GitCheckout | null>;
  spawn?: SpawnFn;
  projectFolder?: (folder: string) => string | Promise<string>;
  desktop?: W.WorkAdapter;
}

export function createCopilotAdapter(
  discovery: W.WorkAdapter,
  deps: Deps
): W.WorkAdapter & { close: () => Promise<void> } {
  const live = new Map<string, Worker>();
  const transactions = new Map<string, Promise<unknown>>();
  const starts = new Set<Promise<W.Result<W.WorkStarted>>>();
  const launching = new Set<string>();
  const readInput = createCopilotInputReader();
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
      cliPath: await deps.resolveCliPath(),
      expectedVersion: COPILOT_CLI_VERSION,
      sessionId: record.work.ref.id,
      cwd: record.directory,
      stateDirectory: join(deps.directory, record.work.ref.id),
      model: record.work.model!,
      effort: record.work.effort,
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
    if (!request.model)
      return { reason: reject('unsupported_model', 'Choose an explicit Copilot model ID.') };
    const preparation = workStartPreparation.admit(request.preparation, false);
    return 'reason' in preparation ? preparation : { value: request };
  };
  const prepare = async (
    folder: string,
    request: W.StartRequest
  ): Promise<Gate<{ id: string; directory: string }>> => {
    const directory = fs.realpathSync(folder);
    if (!fs.statSync(directory).isDirectory())
      return { reason: reject('invalid_place', 'Copilot execution needs a directory.') };
    const id = crypto.randomUUID();
    const prepared = await prepareWorkerFolder(
      directory,
      {
        worktreesDir: deps.worktreesDir ?? join(deps.directory, 'worktrees'),
        newId: () => id,
        gitCheckout: deps.gitCheckout ?? (async () => null),
        spawn: deps.spawn ?? spawnProcess,
      },
      request.inPlace
    );
    return prepared.ok ? { value: { id, directory: prepared.value.cwd } } : { reason: prepared };
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
        ...workExecutionLocation(location.directory, deps.machine),
        status: 'queued',
        lastActivityAt: Date.now(),
        model: request.model,
        ...(request.effort === undefined
          ? {}
          : { effort: workStartConfiguration.normalize(request.effort) }),
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
      if (error instanceof CopilotEffortUnavailableError && error.cause === undefined)
        return reject('unsupported_effort', error.message);
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
    .pipe(prepare, ['started', 'request'], 'result:started')
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
  const detail = (record: Record, receipt?: Receipt, since?: number): W.Result<W.WorkDetail> => {
    if (record.pendingSubmission && !receipt && !record.archived) return unavailable();
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
      !record.archived &&
      !input?.outcome &&
      (snapshot.status === 'unreachable' ||
        (!live.has(work.ref.id) && !['done', 'failed', 'stopped'].includes(snapshot.status)))
    )
      return unavailable();
    return {
      ok: true,
      value: {
        ...work,
        status: record.archived
          ? 'stopped'
          : snapshot.status === 'unreachable' || (!live.has(work.ref.id) && input?.outcome)
            ? input!.outcome!
            : snapshot.status,
        ...(record.archived ? { archived: true } : {}),
        startReceipt: work.receipt,
        ...readCopilotObservations(
          join(deps.directory, work.ref.id, 'session-state', work.ref.id, 'events.jsonl'),
          work.ref.id,
          snapshot.inputs,
          (id) => Object.hasOwn(snapshot.inputs, id) || fs.existsSync(inputPath(work.ref.id, id)),
          since
        ),
        execution: { directory: record.directory, machine: deps.machine },
        ...(input?.replyReport ? { lastReply: input.replyReport } : {}),
        inputEvidence:
          receipt && input && !(record.archived && input.state === 'pending')
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
        waitingFor:
          !record.archived && snapshot.status === 'needs_you' ? 'Permission denied.' : undefined,
      },
    };
  };
  const status = (superpipe({})('copilot-status') as PipelineAPI)
    .input(['ref', 'receipt', 'since'])
    .pipe(lookup, 'ref', 'result:detail')
    .pipe(refresh, 'detail', 'record')
    .pipe(detail, ['record', 'receipt', 'since'], 'detail')
    .endAsync('detail') as (
    ref: W.WorkRef,
    receipt?: Receipt,
    since?: number
  ) => Promise<W.Result<W.WorkDetail>>;
  const admitSend = (record: Record): Gate<Record> => {
    if (record.archived) return { reason: reject('not_open', 'Copilot work is archived.') };
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
  const deliver = async (
    record: Record,
    message: string,
    mode: InputMode
  ): Promise<W.Result<W.WorkDelivery>> => {
    const id = record.work.ref.id;
    let owned = live.get(id);
    const resumed = !owned;
    let submitAttempted = false;
    try {
      owned ??= await open(record, true);
      record.pendingSubmission = true;
      save(record);
      submitAttempted = true;
      const receipt = await owned.submit(message, mode);
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
          ...(!observed && mode === 'enqueue' ? { queuedSubmissionId: receipt.inputId } : {}),
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
    .input(['ref', 'message', 'mode'])
    .pipe(lookup, 'ref', 'result:delivery')
    .pipe(refresh, 'delivery', 'delivery')
    .pipe(admitSend, 'delivery', 'result:delivery')
    .pipe(deliver, ['delivery', 'message', 'mode'], 'delivery')
    .endAsync('delivery') as (
    ref: W.WorkRef,
    message: string,
    mode: InputMode
  ) => Promise<W.Result<W.WorkDelivery>>;
  const admitRename = (record: Record, title: string): Gate<Record> => {
    if (record.archived) return { reason: reject('not_open', 'Copilot work is archived.', true) };
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
  const withdrawal = (queuedSubmissionId: string, withdrawn: boolean): W.WorkWithdrawal => ({
    queuedSubmissionId,
    withdrawn,
    ...(!withdrawn ? { reason: 'not_queued' as const } : {}),
  });
  const admitWithdraw = (record: Record, inputId: string): Gate<Record> => {
    if (
      !Object.hasOwn(record.snapshot.inputs, inputId) &&
      !fs.existsSync(inputPath(record.work.ref.id, inputId))
    )
      return { reason: reject('not_found', 'Not a queued input of this owned session.') };
    if (['done', 'failed', 'stopped'].includes(record.snapshot.status)) return { value: record };
    if (closed || record.snapshot.status === 'unreachable' || !live.has(record.work.ref.id))
      return { reason: unavailable() };
    return { value: record };
  };
  const applyWithdraw = async (
    record: Record,
    inputId: string
  ): Promise<W.Result<W.WorkWithdrawal>> => {
    const owned = live.get(record.work.ref.id);
    if (!owned) return { ok: true, value: withdrawal(inputId, false) };
    const withdrawn = await owned.withdraw(inputId);
    record.snapshot = await owned.snapshot();
    if (withdrawn && record.latestReceipt?.inputId === inputId) delete record.latestReceipt;
    save(record);
    return { ok: true, value: withdrawal(inputId, withdrawn) };
  };
  const withdraw = (superpipe({})('copilot-withdraw') as PipelineAPI)
    .input(['ref', 'inputId'])
    .pipe(lookup, 'ref', 'result:withdrawn')
    .pipe(refresh, 'withdrawn', 'withdrawn')
    .pipe(admitWithdraw, ['withdrawn', 'inputId'], 'result:withdrawn')
    .pipe(applyWithdraw, ['withdrawn', 'inputId'], 'withdrawn')
    .endAsync('withdrawn') as (
    ref: W.WorkRef,
    inputId: string
  ) => Promise<W.Result<W.WorkWithdrawal>>;
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
  const compact = (superpipe({})('copilot-compact') as PipelineAPI)
    .input(['ref'])
    .pipe(lookup, 'ref', 'result:compaction')
    .pipe(refresh, 'compaction', 'compaction')
    .pipe(
      async (record: Record): Promise<W.Result<{ compacted: boolean }>> => {
        if (record.archived) return reject('not_open', 'Copilot work is archived.');
        if (closed || record.pendingSubmission || record.snapshot.status === 'unreachable')
          return unavailable();
        if (['queued', 'running', 'needs_you'].includes(record.snapshot.status))
          return reject('busy', 'Copilot work still has an active input.');
        const id = record.work.ref.id;
        const worker = await open(record, true);
        try {
          return (await worker.compact())
            ? { ok: true, value: { compacted: true } }
            : reject('not_delivered', 'Copilot did not complete compaction.');
        } catch (error) {
          return reject('not_delivered', errorMessage(error));
        } finally {
          live.delete(id);
          await worker.close();
        }
      },
      'compaction',
      'compaction'
    )
    .endAsync('compaction') as (ref: W.WorkRef) => Promise<W.Result<{ compacted: boolean }>>;
  const admitArchive = (record: Record, admit: W.ArchiveAdmission): Gate<Record> => {
    if (
      launching.has(record.work.ref.id) ||
      (live.has(record.work.ref.id) &&
        !['done', 'failed', 'stopped'].includes(record.snapshot.status))
    )
      return { reason: reject('busy', 'Copilot work still has a live turn.', true) };
    const refused = admit();
    return refused ? { reason: refused } : { value: record };
  };
  const applyArchive = async (record: Record): Promise<W.Result<W.WorkArchived>> => {
    const archived = !record.archived;
    if (archived) {
      const { mtime } = fs.statSync(path(record.work.ref.id));
      record.archived = true;
      save(record);
      fs.utimesSync(path(record.work.ref.id), mtime, mtime);
    }
    await live.get(record.work.ref.id)?.close();
    live.delete(record.work.ref.id);
    const worktree = await cleanupOwnedWorktree(record.directory, [
      deps.worktreesDir ?? join(deps.directory, 'worktrees'),
    ]);
    return { ok: true, value: { archived, ...(worktree ? { worktree } : {}) } };
  };
  const archive = (superpipe({})('copilot-archive') as PipelineAPI)
    .input(['ref', 'admit'])
    .pipe(lookup, 'ref', 'result:archived')
    .pipe(refresh, 'archived', 'archived')
    .pipe(admitArchive, ['archived', 'admit'], 'result:archived')
    .pipe(applyArchive, 'archived', 'archived')
    .endAsync('archived') as (
    ref: W.WorkRef,
    admit: W.ArchiveAdmission
  ) => Promise<W.Result<W.WorkArchived>>;
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
          !record.archived &&
          (status === 'unreachable' || (!owner && !['done', 'failed', 'stopped'].includes(status)));
        return {
          ok: true,
          value: {
            ...record.work,
            place: { ...record.work.place, folder, name: basename(folder) || folder },
            status: record.archived
              ? 'stopped'
              : status === 'unreachable'
                ? record.pendingSubmission
                  ? 'queued'
                  : record.work.status
                : status,
            ...(record.archived ? { archived: true } : {}),
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
    },
    deps.desktop
  );
  const owns = (id: string) => copilotOwnsSession(deps.directory, id);
  const mutate = <T>(
    ref: W.WorkRef,
    verb: W.WorkVerb,
    effect: () => Promise<W.Result<T>>,
    desktopEffect: () => Promise<W.Result<T>> | undefined
  ) =>
    guard(async () => {
      if (!owns(ref.id) && (await deps.desktop?.status?.(ref))?.ok)
        return (
          (deps.desktop?.capabilities.includes(verb) && (await desktopEffect())) ||
          reject('unsupported', 'Open the Copilot app to control this Desktop-owned session.')
        );
      return effect();
    }, ref.id);
  const startPreferred: NonNullable<W.WorkAdapter['start']> = async (request, context) => {
    if (deps.desktop?.capabilities.includes('start') && deps.desktop.start) {
      const result = await deps.desktop.start(request, context);
      if (result.ok || result.reason !== 'unreachable' || !result.notSent) return result;
    }
    return start(request);
  };
  return {
    ...discovery,
    supportsStartEffort: true,
    resolveStartConfiguration: async (request) => {
      if (deps.desktop?.capabilities.includes('start'))
        return { ok: true, value: { model: request.model, effort: request.effort } };
      const selected = admit(request);
      return 'reason' in selected
        ? selected.reason
        : {
            ok: true,
            value: {
              model: selected.value.model,
              effort:
                selected.value.effort && workStartConfiguration.normalize(selected.value.effort),
            },
          };
    },
    find,
    readInput: async (id, marker) =>
      owns(id)
        ? readInput(join(deps.directory, id, 'session-state', id, 'events.jsonl'), id, marker)
        : (deps.desktop?.readInput?.(id, marker) ?? null),
    readTurns: (id, around, before, after, cursor) => {
      if (!owns(id)) return deps.desktop?.readTurns?.(id, around, before, after, cursor) ?? null;
      return readCopilotHistory(
        join(deps.directory, id, 'session-state', id, 'events.jsonl'),
        id,
        around,
        before,
        after,
        cursor
      );
    },
    capabilities: [
      'find',
      'start',
      'rename',
      'send',
      'steer',
      'queue',
      'withdraw',
      'status',
      'turns',
      'stop',
      'compact',
      'archive',
    ] as const,
    steerBehavior: 'best_effort',
    start: (request, context) => {
      const pending = guard(() => startPreferred(request, context));
      starts.add(pending);
      void pending.finally(() => starts.delete(pending));
      return pending;
    },
    rename: (ref, title, context) =>
      mutate(
        ref,
        'rename',
        () => rename(ref, title),
        () => deps.desktop?.rename?.(ref, title, context)
      ),
    send: (ref, message, context) =>
      mutate(
        ref,
        'send',
        () => send(ref, message, 'enqueue'),
        () => deps.desktop?.send?.(ref, message, context)
      ),
    steer: (ref, message, context) =>
      mutate(
        ref,
        'steer',
        () => send(ref, message, 'immediate'),
        () => deps.desktop?.steer?.(ref, message, context)
      ),
    queue: (ref, message, context) =>
      mutate(
        ref,
        'queue',
        () => send(ref, message, 'enqueue'),
        () => deps.desktop?.queue?.(ref, message, context)
      ),
    withdraw: (ref, inputId, context) =>
      mutate(
        ref,
        'withdraw',
        () => withdraw(ref, inputId),
        () => deps.desktop?.withdraw?.(ref, inputId, context)
      ),
    status: (ref, since, receipt) =>
      guard(async () => {
        if (!owns(ref.id)) {
          const app = await deps.desktop?.status?.(ref, since, receipt);
          if (app && (app.ok || app.reason !== 'not_found')) return app;
        }
        return status(ref, receipt, since);
      }, ref.id),
    stop: (ref, context) =>
      mutate(
        ref,
        'stop',
        () => stop(ref),
        () => deps.desktop?.stop?.(ref, context)
      ),
    compact: (ref, context) =>
      mutate(
        ref,
        'compact',
        () => compact(ref),
        () => deps.desktop?.compact?.(ref, context)
      ),
    turns: (ref, cursor, limit) =>
      guard(async () => {
        const record = lookup(ref);
        if ('reason' in record)
          return (await deps.desktop?.turns?.(ref, cursor, limit)) ?? record.reason;
        return readCopilotTurnFacts(
          join(deps.directory, ref.id, 'session-state', ref.id, 'events.jsonl'),
          ref.id,
          cursor,
          limit,
          record.value.snapshot.inputs
        );
      }, ref.id),
    archive: (ref, admit) =>
      mutate(
        ref,
        'archive',
        () => archive(ref, admit),
        () => deps.desktop?.archive?.(ref, admit)
      ),
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
