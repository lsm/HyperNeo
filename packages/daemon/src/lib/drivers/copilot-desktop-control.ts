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
import type { Result, WorkAdapter, WorkRef, WorkSummary } from './types.ts';
import { reject } from './work-operations.ts';

type Controls = Pick<
  WorkAdapter,
  'start' | 'send' | 'stop' | 'queue' | 'withdraw' | 'rename' | 'archive'
>;
const Id = z.string().regex(/^[\w-]{1,128}$/);
const Queue = z.array(z.object({ id: Id, message_id: Id.optional() }));
const Models = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    supportedReasoningEfforts: z.array(z.string()).optional(),
    supported_reasoning_efforts: z.array(z.string()).optional(),
  })
);
const Project = z.object({ id: Id });
const Workspace = z.object({ id: Id, session_id: Id.optional() });
const Removed = z.object({ item_id: Id, removed: z.boolean() });

export function createCopilotDesktopControl(
  deps: StartFolderDeps & {
    machine: string;
    find: (id: string) => Promise<CopilotDesktopSession | undefined>;
    summarize: (session: CopilotDesktopSession) => WorkSummary;
    readInput: (id: string, text: string) => Promise<{ messageId: string } | null>;
  }
): Required<Controls> {
  const run = async <T>(
    request: CopilotDesktopFrame,
    accept: (frame: CopilotDesktopFrame) => T | undefined
  ): Promise<Result<T>> => {
    const endpoint = readCopilotDesktopEndpoint(deps.homeDir);
    return endpoint
      ? callCopilotDesktop(endpoint, request, accept)
      : reject('unreachable', 'Open the signed-in Copilot Desktop app.', true);
  };
  const target = async (ref: WorkRef, closed = false) => {
    const session = Id.safeParse(ref.id).success ? await deps.find(ref.id) : undefined;
    if (!session || session.id !== ref.id || !isAbsolute(session.folder))
      return { reason: reject('not_found', 'Copilot Desktop session not found.', true) };
    if (session.archived && !closed)
      return { reason: reject('not_open', 'Copilot Desktop session is archived.', true) };
    return { value: session };
  };
  const submit: NonNullable<WorkAdapter['send']> = async (ref, message) => {
    const found = await target(ref);
    if ('reason' in found) return found.reason!;
    const sent = await run(
      { type: 'send_message', session_id: ref.id, prompt: message, mode: 'enqueue' },
      (frame) =>
        frame.type === 'session_message_sent' && frame.session_id === ref.id
          ? Id.safeParse(frame.message_id).data
          : undefined
    );
    if (!sent.ok) return sent;
    return {
      ok: true,
      value: {
        delivered: false,
        queuedSubmissionId: sent.value,
        receipt: { executionId: ref.id, inputId: sent.value },
      },
    };
  };
  return {
    async start(request) {
      const prep = workStartPreparation.admit(request.preparation, false);
      if ('reason' in prep) return prep.reason;
      let settings: { model?: string; effort?: string } = {};
      if (request.model || request.effort) {
        const models = await run({ type: 'list_models' }, (frame) =>
          frame.type === 'models_list' ? Models.safeParse(frame.models).data : undefined
        );
        if (!models.ok) return { ...models, notSent: true };
        const selected = workStartConfiguration.select(
          request,
          models.value.map((model) => ({
            id: model.id,
            aliases: model.name ? [model.name] : [],
            efforts: model.supportedReasoningEfforts ?? model.supported_reasoning_efforts ?? [],
          }))
        );
        if ('ok' in selected) return selected;
        settings = selected;
      }
      const path = selectLocalStartFolder(request, deps, 'Copilot Desktop needs a local folder.');
      if ('reason' in path) return path.reason;
      if (!statSync(path.value).isDirectory())
        return reject('invalid_place', 'Copilot Desktop needs a directory.', true);
      const canonical = realpathSync(path.value);
      const project = await run({ type: 'create_project_from_path', path: canonical }, (frame) =>
        frame.type === 'project_created' || frame.type === 'project_updated'
          ? Project.safeParse(frame.project).data
          : undefined
      );
      if (!project.ok) return { ...project, notSent: true };
      const requestId = randomUUID();
      const created = await run(
        {
          type:
            request.inPlace || request.prepareFolder || !existsSync(join(canonical, '.git'))
              ? 'create_folder_workspace'
              : 'create_worktree_workspace',
          project_id: project.value.id,
          name: request.sessionTitle ?? request.title,
          request_id: requestId,
          kickoff_prompt: request.message,
          kickoff_model: settings.model,
          kickoff_reasoning_effort: settings.effort,
        },
        (frame) =>
          frame.type === 'workspace_created' && frame.request_id === requestId
            ? Workspace.safeParse(frame.workspace).data
            : undefined
      );
      if (!created.ok) return created;
      const id = created.value.session_id;
      if (!id)
        return reject(
          'unreachable',
          'Desktop created a workspace but its session is unconfirmed. Do not replay.'
        );
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
          const input = confirmed.ok && (await deps.readInput(id, request.message));
          if (input && input.messageId.startsWith('user:')) {
            return {
              ok: true,
              value: {
                ...deps.summarize(session),
                receipt: { executionId: id, inputId: input.messageId.slice(5) },
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
    send: submit,
    queue: submit,
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
      const queued = (frame: CopilotDesktopFrame) =>
        frame.type === 'session_queue' && frame.session_id === ref.id
          ? Queue.safeParse(frame.items).data
          : undefined;
      const pending = await run({ type: 'get_session_queue', session_id: ref.id }, queued);
      if (!pending.ok) return pending;
      const item = pending.value.find((entry) => entry.message_id === queuedSubmissionId);
      if (!item)
        return { ok: true, value: { queuedSubmissionId, withdrawn: false, reason: 'not_queued' } };
      return run(
        { type: 'remove_session_queue_item', session_id: ref.id, item_id: item.id },
        (frame) => {
          if (frame.session_id !== ref.id) return undefined;
          const result = Removed.safeParse(frame);
          if (!result.success || result.data.item_id !== item.id) return undefined;
          return result.data.removed
            ? { queuedSubmissionId, withdrawn: true }
            : { queuedSubmissionId, withdrawn: false, reason: 'not_queued' as const };
        }
      );
    },
    async archive(ref, admit) {
      const found = await target(ref, true);
      if ('reason' in found) return found.reason!;
      const denied = admit();
      if (denied) return denied;
      if (found.value.archived) return { ok: true, value: { archived: true } };
      return run(
        {
          type: 'archive_workspace',
          workspace_id: found.value.workspaceId,
          delete_worktree: false,
        },
        (frame) =>
          frame.type === 'workspace_archived' && frame.workspace_id === found.value.workspaceId
            ? { archived: true }
            : undefined
      );
    },
  };
}
