import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import type { WorkAdapter, WorkDetail, WorkInputReceiptSchema, WorkRef } from './types.ts';
import { reject } from './work-operations.ts';
import type { prepareWorkerFolder } from './work-placement.ts';

const ADAPTER = 'cursor-cli';
const Config = z.object({
  configOptions: z
    .array(
      z
        .object({
          id: z.string(),
          category: z.string().optional(),
          currentValue: z.string(),
          options: z.array(z.object({ value: z.string() })).optional(),
        })
        .passthrough()
    )
    .optional(),
});
const Session = Config.extend({ sessionId: z.string().min(1) });
const Update = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.string(),
    content: z.object({ type: z.string(), text: z.string().optional() }).optional(),
  }),
});
const Completion = z.object({ stopReason: z.string() });
type Receipt = z.infer<typeof WorkInputReceiptSchema>;
type Active = {
  transport: ProcessJsonRpcTransport;
  ended: Promise<string>;
  acknowledge(): void;
  receipt: Receipt;
  reply: string;
};
type Entry = { detail: WorkDetail; active?: Active; opening?: true };

async function request(transport: ProcessJsonRpcTransport, method: string, params: object) {
  const reply = await transport.sendRequest(method, params);
  if ('result' in reply) return reply.result;
  throw new Error(
    reply.error.message === 'Authentication required'
      ? 'Cursor CLI needs sign-in. Run cursor-agent login.'
      : `Cursor CLI rejected ${method} (${reply.error.code}).`
  );
}

async function configure(
  transport: ProcessJsonRpcTransport,
  sessionId: string,
  config: z.infer<typeof Config>,
  requested: { model?: string; effort?: string }
) {
  const select = (category: string) =>
    config.configOptions?.find((item) => item.category === category);
  const model = select('model');
  const base = (id: string) => id.split('[', 1)[0];
  const effort = (id?: string) => id?.match(/(?:\[|,)(?:reasoning_)?effort=([^,\]]+)/)?.[1];
  const requestedModel = requested.model ?? model?.currentValue;
  const variants =
    model?.options
      ?.map(({ value }) => value)
      .filter((value) =>
        requestedModel?.includes('[') && requested.model
          ? value === requestedModel
          : base(value) === (requestedModel && base(requestedModel))
      ) ?? [];
  const matchingEffort = variants.filter((id) => effort(id) === requested.effort);
  let targetModel = requested.model;
  if (targetModel && model) {
    if (targetModel === base(model.currentValue)) targetModel = model.currentValue;
    else if (variants.length === 1) targetModel = variants[0];
  }
  if (requested.effort !== undefined && matchingEffort.length === 1)
    targetModel = matchingEffort[0];
  async function set(category: string, target: string, label: string) {
    const option = select(category);
    if (!option) throw new Error(`Cursor did not advertise ${label} for this session.`);
    if (option.currentValue !== target) {
      config = Config.parse(
        await request(transport, 'session/set_config_option', {
          sessionId,
          configId: option.id,
          value: target,
        })
      );
      if (select(category)?.currentValue !== target)
        throw new Error(`Cursor did not confirm the requested ${label}.`);
    }
  }
  if (targetModel !== undefined) await set('model', targetModel, 'model');
  const actualEffort = () =>
    select('thought_level')?.currentValue ?? effort(select('model')?.currentValue);
  if (requested.effort !== undefined && actualEffort() !== requested.effort)
    await set('thought_level', requested.effort, 'thinking effort for this model');
  return { model: select('model')?.currentValue, effort: actualEffort() };
}

export function createCursorCliControl(
  command: string,
  machine: string,
  prepare: (folder: string, inPlace: boolean) => ReturnType<typeof prepareWorkerFolder>
): WorkAdapter & { close(): Promise<void> } {
  const sessions = new Map<string, Entry>();
  const connections = new Set<ProcessJsonRpcTransport>();

  async function close(transport: ProcessJsonRpcTransport) {
    try {
      await transport.close();
    } finally {
      connections.delete(transport);
    }
  }

  async function connect(directory: string) {
    const transport = new ProcessJsonRpcTransport({
      command,
      args: ['--sandbox', 'enabled', 'acp'],
      cwd: directory,
      env: buildSafeProcessEnv(),
      replaceEnv: true,
      onStderr: () => {},
      onRequest: ({ method, id }) => {
        if (method === 'session/request_permission')
          transport.sendResponse(id, { outcome: { outcome: 'cancelled' } });
        else transport.sendErrorResponse(id, { code: -32601, message: 'Method not supported' });
      },
      onNotification: ({ method, params }) => {
        if (method !== 'session/update') return;
        const parsed = Update.safeParse(params);
        if (!parsed.success) return;
        const active = sessions.get(parsed.data.sessionId)?.active;
        if (active?.transport !== transport) return;
        const { sessionUpdate, content } = parsed.data.update;
        if (
          [
            'agent_message_chunk',
            'agent_thought_chunk',
            'tool_call',
            'user_message_chunk',
          ].includes(sessionUpdate)
        )
          active.acknowledge();
        if (sessionUpdate === 'agent_message_chunk' && content?.type === 'text')
          active.reply = (active.reply + (content.text ?? '')).slice(0, 16_000);
      },
    });
    connections.add(transport);
    try {
      await request(transport, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
      return transport;
    } catch (error) {
      await close(transport);
      throw error;
    }
  }

  function begin(entry: Entry, transport: ProcessJsonRpcTransport, text: string) {
    const id = entry.detail.ref.id;
    const receipt = { executionId: id, inputId: crypto.randomUUID() };
    const accepted = Promise.withResolvers<boolean>();
    const active: Active = {
      transport,
      receipt,
      reply: '',
      ended: Promise.resolve('failed'),
      acknowledge: () => {
        entry.detail.inputEvidence = { receipt, state: 'pending', transcriptState: 'accepted' };
        accepted.resolve(true);
      },
    };
    entry.active = active;
    entry.detail = {
      ...entry.detail,
      status: 'running',
      lastActivityAt: Date.now(),
      lastReply: undefined,
      lastReplyAt: undefined,
      inputEvidence: { receipt, state: 'pending' },
    };
    active.ended = request(transport, 'session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text }],
    })
      .then((value) => {
        const result = Completion.parse(value);
        active.acknowledge();
        return result.stopReason;
      })
      .catch(() => 'failed')
      .then((reason) => {
        const at = Date.now();
        entry.detail = {
          ...entry.detail,
          status: reason === 'cancelled' ? 'stopped' : reason === 'end_turn' ? 'done' : 'failed',
          lastActivityAt: at,
          ...(active.reply ? { lastReply: active.reply, lastReplyAt: at } : {}),
          inputEvidence: active.reply
            ? {
                receipt,
                state: 'observed',
                transcriptState: reason === 'end_turn' ? 'completed' : 'accepted',
                exchange: [
                  { at, role: 'user', text },
                  { at, role: 'agent', text: active.reply },
                ],
                exchangeCut: false,
                replyAvailability: reason === 'end_turn' ? 'complete' : 'incomplete',
                replyReport: active.reply,
                replyAt: at,
              }
            : { receipt, state: 'unavailable', replyAvailability: 'reply_unavailable' },
        };
        entry.active = undefined;
        void close(transport).catch(() => {});
        accepted.resolve(false);
        return reason;
      });
    let timer: ReturnType<typeof setTimeout>;
    const timed = new Promise<false>((done) => {
      timer = setTimeout(() => done(false), 8_000);
    });
    return {
      receipt,
      accepted: Promise.race([accepted.promise, timed]).finally(() => clearTimeout(timer)),
    };
  }

  const notOwned = () =>
    reject('not_found', 'This daemon has no live record of that Cursor CLI worker.');
  return {
    id: ADAPTER,
    capabilities: ['find', 'start', 'send', 'status', 'stop'],
    supportsStartEffort: true,
    find: (query) =>
      query.spaceId
        ? []
        : [...sessions.values()].flatMap(({ detail }) => {
            const { place, title, ref, lastActivityAt } = detail;
            if (
              (query.folder && place.folder !== query.folder) ||
              (query.idPrefix && !ref.id.startsWith(query.idPrefix)) ||
              (query.text &&
                !`${title} ${place.folder}`.toLowerCase().includes(query.text.toLowerCase()))
            )
              return [];
            return [
              {
                place,
                lastActivityAt,
                openCount: 1,
                archivedCount: 0,
                adapters: [ADAPTER],
                work: [detail],
              },
            ];
          }),
    start: async (input) => {
      const folder = input.place.folder;
      if (!folder || !isAbsolute(folder) || !(await stat(folder).catch(() => null))?.isDirectory())
        return reject('invalid_place', 'Cursor CLI needs an existing absolute workspace folder.');
      const prepared = await prepare(folder, Boolean(input.inPlace));
      if (!prepared.ok) return prepared;
      let transport: ProcessJsonRpcTransport | undefined;
      try {
        const cwd = prepared.value.cwd;
        transport = await connect(cwd);
        const value = Session.parse(
          await request(transport, 'session/new', { cwd, mcpServers: [] })
        );
        const config = await configure(transport, value.sessionId, value, input);
        const ref = { adapter: ADAPTER, id: value.sessionId };
        const entry: Entry = {
          detail: {
            ref,
            title: input.sessionTitle ?? input.title,
            place: input.place,
            execution: { machine, directory: cwd },
            status: 'running',
            lastActivityAt: Date.now(),
            ...config,
          },
        };
        sessions.set(ref.id, entry);
        const started = begin(entry, transport, input.message);
        const accepted = await started.accepted;
        return {
          ok: true,
          value: {
            ...entry.detail,
            ...(accepted ? { receipt: started.receipt } : {}),
          },
        };
      } catch (error) {
        if (transport) await close(transport).catch(() => {});
        await prepared.value.release();
        return reject(
          'not_delivered',
          error instanceof Error ? error.message : 'Cursor CLI start failed.'
        );
      }
    },
    send: async (ref: WorkRef, text: string) => {
      const entry = sessions.get(ref.id);
      const cwd = entry?.detail.execution?.directory;
      if (!entry || !cwd) return notOwned();
      if (entry.active || entry.opening)
        return reject('busy', 'Cursor CLI is already running a turn.');
      entry.opening = true;
      let transport: ProcessJsonRpcTransport | undefined;
      try {
        transport = await connect(cwd);
        const config = Config.parse(
          await request(transport, 'session/load', { cwd, sessionId: ref.id, mcpServers: [] })
        );
        await configure(transport, ref.id, config, entry.detail);
        const started = begin(entry, transport, text);
        return (await started.accepted)
          ? { ok: true, value: { delivered: true, receipt: started.receipt } }
          : { ok: true, value: { delivered: false, unconfirmed: true } };
      } catch (error) {
        if (transport) await close(transport).catch(() => {});
        return reject(
          'not_delivered',
          error instanceof Error ? error.message : 'Cursor CLI resume failed.'
        );
      } finally {
        entry.opening = undefined;
      }
    },
    status: async (ref, _since, receipt) => {
      const entry = sessions.get(ref.id);
      if (!entry) return notOwned();
      const { inputEvidence, ...detail } = entry.detail;
      return {
        ok: true,
        value: {
          ...detail,
          ...(receipt &&
          inputEvidence?.receipt.inputId === receipt.inputId &&
          inputEvidence.receipt.executionId === receipt.executionId
            ? { inputEvidence }
            : {}),
        },
      };
    },
    stop: async (ref) => {
      const entry = sessions.get(ref.id);
      if (!entry) return notOwned();
      const active = entry.active;
      if (!active) return { ok: true, value: { stopped: false } };
      active.transport.sendNotification('session/cancel', { sessionId: ref.id });
      let timer: ReturnType<typeof setTimeout>;
      const timed = new Promise<string>((done) => {
        timer = setTimeout(() => done('pending'), 8_000);
      });
      const reason = await Promise.race([active.ended, timed]).finally(() => clearTimeout(timer));
      return reason === 'pending'
        ? reject('not_delivered', 'Cursor CLI did not confirm cancellation.')
        : { ok: true, value: { stopped: reason === 'cancelled' } };
    },
    close: async () => {
      await Promise.all([...connections].map(close));
    },
  };
}
