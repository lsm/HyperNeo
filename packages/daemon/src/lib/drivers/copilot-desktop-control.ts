import { existsSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  type CopilotDesktopFrame,
  callCopilotDesktop,
  readCopilotDesktopEndpoint,
} from './copilot-desktop-channel.ts';
import type { CopilotDesktopSession } from './copilot-desktop-adapter.ts';
import { selectLocalStartFolder, type StartFolderDeps } from './start-folder.ts';
import { workStartConfiguration } from './start-configuration.ts';
import { workStartPreparation } from './start-preparation.ts';
import { COPILOT_DESKTOP_UNAVAILABLE } from './types.ts';
import type { Result, WorkAdapter, WorkDelivery, WorkRef, WorkSummary } from './types.ts';
import { reject } from './work-operations.ts';

type Controls = Pick<
  WorkAdapter,
  'start' | 'send' | 'steer' | 'stop' | 'compact' | 'queue' | 'withdraw' | 'rename' | 'archive'
>;
const Id = z.string().regex(/^[\w-]{1,128}$/);
const Queue = z.array(z.object({ id: Id, message_id: Id.optional() }));
const Repository = z.object({ id: Id });
const Workspace = z.object({ id: Id, displayPath: z.string() });
const CreatedSession = z.object({
  session_id: Id,
  workspace_id: Id,
  model: z.string().nullish(),
  reasoning_effort: z.string().nullish(),
});
const QueueSnapshot = z.object({ items: Queue });
const Removal = z.object({ outcome: z.object({ changed: z.boolean() }), snapshot: QueueSnapshot });
const Compaction = z.object({
  type: z.enum(['session.compaction_start', 'session.compaction_complete']),
  data: z.object({
    compactionAttemptId: Id,
    trigger: z.literal('manual'),
    success: z.boolean().optional(),
    outcome: z.string().optional(),
  }),
});

export function createCopilotDesktopControl(
  deps: StartFolderDeps & {
    machine: string;
    find: (id: string) => Promise<CopilotDesktopSession | undefined>;
    summarize: (session: CopilotDesktopSession) => WorkSummary;
    observedInput: (id: string, inputId: string) => Promise<boolean>;
  }
): Required<Controls> {
  const run = async <T>(
    request: CopilotDesktopFrame,
    accept: (frame: CopilotDesktopFrame) => T | undefined,
    timeoutMs?: number
  ): Promise<Result<T>> => {
    const endpoint = readCopilotDesktopEndpoint(deps.homeDir);
    return endpoint
      ? callCopilotDesktop(endpoint, request, accept, timeoutMs)
      : reject('unreachable', COPILOT_DESKTOP_UNAVAILABLE, true);
  };
  const target = async (ref: WorkRef, closed = false) => {
    const session = Id.safeParse(ref.id).success ? await deps.find(ref.id) : undefined;
    if (!session || session.id !== ref.id || !isAbsolute(session.folder))
      return { reason: reject('not_found', 'Copilot Desktop session not found.', true) };
    if (session.archived && !closed)
      return { reason: reject('not_open', 'Copilot Desktop session is archived.', true) };
    return { value: session };
  };
  const submit = async (
    ref: WorkRef,
    message: string,
    mode: 'enqueue' | 'immediate'
  ): Promise<Result<WorkDelivery>> => {
    const found = await target(ref);
    if ('reason' in found) return found.reason!;
    const requestId = randomUUID();
    const sent = await run(
      {
        request_id: requestId,
        type: 'send_message',
        session_id: ref.id,
        prompt: message,
        mode,
      },
      (frame) =>
        frame.type === 'session_message_sent' &&
        frame.session_id === ref.id &&
        frame.request_id === requestId
          ? Id.safeParse(frame.message_id).data
          : undefined
    );
    if (!sent.ok) return sent;
    return {
      ok: true,
      value: {
        delivered: false,
        ...(mode === 'enqueue' ? { queuedSubmissionId: sent.value } : {}),
        receipt: { executionId: ref.id, inputId: sent.value },
      },
    };
  };
  return {
    async start(request) {
      const prep = workStartPreparation.admit(request.preparation, false);
      if ('reason' in prep) return prep.reason;
      const settings = { model: request.model, effort: request.effort };
      const path = selectLocalStartFolder(request, deps, 'Copilot Desktop needs a local folder.');
      if ('reason' in path) return path.reason;
      if (!statSync(path.value).isDirectory())
        return reject('invalid_place', 'Copilot Desktop needs a directory.', true);
      const canonical = realpathSync(path.value);
      const endpoint = readCopilotDesktopEndpoint(deps.homeDir);
      if (!endpoint) return reject('unreachable', COPILOT_DESKTOP_UNAVAILABLE, true);
      const runStart: typeof run = (frame, accept, timeoutMs) =>
        callCopilotDesktop(endpoint, frame, accept, timeoutMs);
      const probe = (type: string, replyType: string) => {
        const requestId = randomUUID();
        return runStart(
          { type, request_id: requestId },
          (frame) =>
            frame.type === replyType && frame.request_id === requestId ? true : undefined,
          5000
        );
      };
      const modern = (await probe('list_repositories', 'repository_list')).ok;
      if (!modern && !(await probe('list_projects', 'project_list')).ok)
        return reject(
          'unreachable',
          'Copilot Desktop did not confirm which startup protocol it supports. No session was created.',
          true
        );
      const repositoryRequest = randomUUID();
      const framePrefix = modern ? 'repository' : 'project';
      const repository = await runStart(
        { type: `create_${framePrefix}_from_path`, path: canonical, request_id: repositoryRequest },
        (frame) =>
          (frame.type === `${framePrefix}_created` || frame.type === `${framePrefix}_updated`) &&
          frame.request_id === repositoryRequest
            ? Repository.safeParse(frame[framePrefix]).data
            : undefined
      );
      if (!repository.ok) return { ...repository, notSent: true };
      const requestId = randomUUID();
      const created = await runStart(
        {
          type:
            request.inPlace || request.prepareFolder || !existsSync(join(canonical, '.git'))
              ? 'create_folder_workspace'
              : 'create_worktree_workspace',
          [`${framePrefix}_id`]: repository.value.id,
          name: request.sessionTitle ?? request.title,
          request_id: requestId,
        },
        (frame) =>
          frame.type === 'workspace_created' && frame.request_id === requestId
            ? Workspace.safeParse(frame.workspace).data
            : undefined
      );
      if (!created.ok) return created;
      const workspace = created.value;
      if (!isAbsolute(workspace.displayPath))
        return reject('unreachable', 'Copilot Desktop did not confirm the workspace directory.');
      const sessionRequest = randomUUID();
      const started = await runStart(
        {
          type: 'create_session',
          request_id: sessionRequest,
          workspace_id: workspace.id,
          cwd: workspace.displayPath,
          model: settings.model,
          reasoning_effort: settings.effort,
        },
        (frame) =>
          frame.type === 'session_created' && frame.request_id === sessionRequest
            ? CreatedSession.safeParse(frame).data
            : undefined
      );
      if (!started.ok) return { ...started, notSent: undefined };
      const id = started.value.session_id;
      const confirmed = workStartConfiguration.confirm(settings, {
        model: started.value.model ?? undefined,
        effort: started.value.reasoning_effort ?? undefined,
      });
      if (!confirmed.ok || started.value.workspace_id !== workspace.id)
        return reject(
          'unreachable',
          `Copilot Desktop created session ${id}, but did not confirm the requested settings or workspace. No prompt was sent. Do not replay.`
        );
      const session = await deps.find(id);
      if (
        session?.id !== id ||
        session.workspaceId !== workspace.id ||
        session.folder !== canonical
      )
        return reject('unreachable', 'Copilot Desktop did not confirm the new session.');
      const sent = await submit(deps.summarize(session).ref, request.message, 'enqueue');
      if (!sent.ok) return { ...sent, notSent: undefined };
      const receipt = sent.value.receipt!;
      const deadline = Date.now() + 6000;
      do {
        const session = await deps.find(id);
        if (
          session?.id === id &&
          session.workspaceId === created.value.id &&
          session.folder === canonical
        ) {
          const confirmed = workStartConfiguration.confirm(settings, {
            model: session.model ?? undefined,
            effort: session.effort ?? undefined,
          });
          if (confirmed.ok && (await deps.observedInput(id, receipt.inputId))) {
            return {
              ok: true,
              value: {
                ...deps.summarize(session),
                receipt,
              },
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      return reject(
        'unreachable',
        `Copilot Desktop session ${id} exists, but its settings or input are unconfirmed. Do not replay.`
      );
    },
    send: (ref, message) => submit(ref, message, 'enqueue'),
    steer: (ref, message) => submit(ref, message, 'immediate'),
    queue: (ref, message) => submit(ref, message, 'enqueue'),
    async stop(ref) {
      const found = await target(ref);
      if ('reason' in found) return found.reason!;
      if (!found.value.running) return { ok: true, value: { stopped: false } };
      return run({ type: 'abort_session', session_id: ref.id }, (frame) =>
        frame.type === 'session_event' &&
        frame.session_id === ref.id &&
        z.object({ type: z.literal('abort') }).safeParse(frame.event).success
          ? { stopped: true }
          : undefined
      );
    },
    async compact(ref) {
      const found = await target(ref);
      if ('reason' in found) return found.reason!;
      if (found.value.running) return reject('busy', 'Copilot Desktop session is active.', true);
      const requestId = randomUUID();
      let queued = false;
      let attemptId: string | undefined;
      const result = await run(
        {
          type: 'execute_session_command',
          request_id: requestId,
          session_id: ref.id,
          command_name: 'compact',
          args: '',
          display_text: '/compact',
        },
        (frame) => {
          if (frame.session_id !== ref.id) return;
          if (frame.type === 'session_command_complete' && frame.request_id === requestId) {
            if (frame.outcome !== 'queued') return false;
            queued = true;
          }
          if (!queued || frame.type !== 'session_event') return;
          const event = Compaction.safeParse(frame.event).data;
          if (!event) return;
          if (event.type === 'session.compaction_start')
            attemptId ??= event.data.compactionAttemptId;
          if (
            event.type === 'session.compaction_complete' &&
            event.data.compactionAttemptId === attemptId
          )
            return event.data.success === true && event.data.outcome === 'applied';
        },
        60_000
      );
      if (!result.ok) return result;
      return result.value
        ? { ok: true, value: { compacted: true } }
        : reject('not_delivered', 'Copilot Desktop did not complete compaction.');
    },
    async rename(ref, title) {
      const found = await target(ref);
      if ('reason' in found) return found.reason!;
      return run({ type: 'rename_session', session_id: ref.id, title }, (frame) =>
        frame.type === 'session_title_updated' &&
        frame.session_id === ref.id &&
        frame.title === title
          ? { renamed: true, title }
          : undefined
      );
    },
    async withdraw(ref, queuedSubmissionId) {
      const found = await target(ref);
      if ('reason' in found) return found.reason!;
      const command = <T>(type: string, fields: object, schema: z.ZodType<T>) => {
        const requestId = randomUUID();
        return run({ type, session_id: ref.id, request_id: requestId, ...fields }, (frame) =>
          frame.type === 'command_result' && frame.request_id === requestId
            ? schema.safeParse(frame.data).data
            : undefined
        );
      };
      const pending = await command('get_session_queue', {}, QueueSnapshot);
      if (!pending.ok) return pending;
      const item = pending.value.items.find((entry) => entry.message_id === queuedSubmissionId);
      if (!item)
        return { ok: true, value: { queuedSubmissionId, withdrawn: false, reason: 'not_queued' } };
      const removed = await command('remove_session_queue_item', { id: item.id }, Removal);
      if (!removed.ok) return removed;
      const withdrawn =
        removed.value.outcome.changed &&
        !removed.value.snapshot.items.some((entry) => entry.message_id === queuedSubmissionId);
      return {
        ok: true,
        value: withdrawn
          ? { queuedSubmissionId, withdrawn: true }
          : { queuedSubmissionId, withdrawn: false, reason: 'not_queued' },
      };
    },
    async archive(ref, admit) {
      const found = await target(ref, true);
      if ('reason' in found) return found.reason!;
      const denied = admit();
      if (denied) return denied;
      if (found.value.archived) return { ok: true, value: { archived: true } };
      const requestId = randomUUID();
      return run(
        {
          type: 'archive_workspace',
          request_id: requestId,
          workspace_id: found.value.workspaceId,
          delete_worktree: false,
        },
        (frame) =>
          frame.type === 'workspace_archived' &&
          frame.workspace_id === found.value.workspaceId &&
          frame.request_id === requestId
            ? { archived: true }
            : undefined
      );
    },
  };
}
