import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import catalog from './tool-catalog.json' with { type: 'json' };
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

type Binding = {
  todo_id: string;
  worker_id: string;
  driver_instance_id: string;
  target_app_id: string | null;
};
type Target = { app_id: string; pid: number | null; window_id: number | null };
type Planned = Target & { args: Record<string, unknown> };
type Options = {
  binding: () => Promise<Binding | null>;
  dispatch: (
    binding: Binding,
    name: string,
    args: Record<string, unknown>,
    sent: () => void
  ) => Promise<CallToolResult>;
  audit: (line: string) => void;
  authorize?: (
    binding: Binding,
    name: string,
    args: Record<string, unknown>,
    callId: string
  ) => Promise<{ value: Target } | Context | null>;
};
type Refusal = 'tool_not_allowed' | 'target_unverified' | 'target_mismatch';
type Context = { reason: Refusal; class?: string; app_id?: string };
const explanations: Record<string, string> = {
  tool_not_allowed: 'This tool is not on the desktop allowlist.',
  desktop_not_opted_in: 'This worker has no approved desktop control binding.',
  invalid_arguments: 'The arguments do not match the tool schema or worker.',
  guards_unavailable: 'The trusted desktop host could not check this call.',
  target_unverified: 'The target app could not be verified from its code signature.',
  target_mismatch: 'The addressed process, window or app does not match the verified target.',
  driver_unavailable: 'The desktop driver is not available.',
  driver_error: 'The desktop driver failed after the call was sent.',
};
type Reason = Refusal | 'desktop_not_opted_in' | 'invalid_arguments' | 'guards_unavailable';
const tools = catalog as unknown as Tool[];
const refuse = (reason: Reason) => ({ reason });
const schemas = new Map(
  tools.map((tool) => [
    tool.name,
    z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema),
  ])
);
const plan = (superpipe({})('desktop-mcp-call') as PipelineAPI)
  .input(['name', 'args', 'binding', 'authorize', 'callId'])
  .pipe(
    (name: string) => (schemas.has(name) ? { value: name } : refuse('tool_not_allowed')),
    'name',
    'result:permission'
  )
  .pipe(
    (binding: Binding | null) => (binding ? { value: binding } : refuse('desktop_not_opted_in')),
    ['binding', 'permission'],
    'result:permission'
  )
  .pipe(
    (args: unknown, name: string, binding: Binding) => {
      const parsed = schemas.get(name)!.safeParse(args);
      if (!parsed.success) return refuse('invalid_arguments');
      const values = parsed.data as Record<string, unknown>;
      return values.session === undefined || values.session === binding.worker_id
        ? { value: values }
        : refuse('invalid_arguments');
    },
    ['args', 'name', 'permission'],
    'result:permission'
  )
  .pipe(
    async (
      binding: Binding,
      name: string,
      args: Record<string, unknown>,
      authorize: Options['authorize'],
      callId: string
    ) => {
      const target = await authorize?.(binding, name, args, callId);
      if (!target) return refuse('guards_unavailable');
      return 'reason' in target ? refuse(target.reason) : { value: { ...target.value, args } };
    },
    ['binding', 'name', 'permission', 'authorize', 'callId'],
    'result:permission'
  )
  .endAsync('permission') as (
  name: string,
  args: unknown,
  binding: Binding | null,
  authorize: Options['authorize'],
  callId: string
) => Promise<Planned | Reason>;

function easternTimestamp() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${part('timeZoneName').replace('GMT', '').replace('−', '-')}`;
}

export function createDesktopProxy(options: Options) {
  return {
    list: async () => ((await options.binding()) ? tools : []),
    call: async (name: string, args: unknown): Promise<CallToolResult> => {
      const started = Date.now();
      const callId = randomUUID();
      let binding: Binding | null = null;
      let target: Target | null = null;
      let decision = 'refused';
      let reason = 'driver_unavailable';
      let dispatched = false;
      let context: Partial<Context> = {};
      const authorize: Options['authorize'] =
        options.authorize &&
        (async (...request) => {
          const answer = await options.authorize!(...request);
          if (answer && 'reason' in answer) context = answer;
          return answer;
        });
      const refusal = (): CallToolResult => ({
        isError: true,
        content: [{ type: 'text', text: reason }],
        structuredContent: {
          reason,
          class: context.class ?? null,
          bundle_id: context.app_id ?? null,
          explanation: explanations[reason],
          call_id: callId,
          input_issued: dispatched ? 'unknown' : 'none',
        },
      });
      try {
        binding = schemas.has(name) ? await options.binding() : null;
        const outcome = await plan(name, args, binding, authorize, callId);
        if (typeof outcome === 'string') {
          reason = outcome;
          return refusal();
        }
        target = outcome;
        const result = await options.dispatch(binding!, name, outcome.args, () => {
          dispatched = true;
        });
        decision = result.isError ? 'error' : 'allowed';
        reason = result.isError ? 'driver_error' : 'ok';
        return result;
      } catch {
        decision = 'error';
        reason = dispatched ? 'driver_error' : 'driver_unavailable';
        return refusal();
      } finally {
        options.audit(
          JSON.stringify({
            timestamp: easternTimestamp(),
            call_id: callId,
            todo_id: binding?.todo_id ?? null,
            worker_id: binding?.worker_id ?? null,
            driver_instance_id: binding?.driver_instance_id ?? null,
            tool: schemas.has(name) ? name : 'unlisted',
            target_app_id: target?.app_id ?? context.app_id ?? binding?.target_app_id ?? null,
            target_pid: target?.pid ?? null,
            target_window_id: target?.window_id ?? null,
            decision,
            reason_code: reason,
            duration_ms: Math.max(0, Date.now() - started),
            upstream_dispatched: dispatched,
          })
        );
      }
    },
  };
}
