import {
  CreateStandaloneTaskSchema,
  SaveArtifactSchema,
  SendMessageSchema,
} from '../space/actions/node-agent-schemas.ts';
import {
  ApproveTaskSchema,
  MarkCompleteSchema,
  SubmitForApprovalSchema,
} from '../space/actions/task-agent-schemas.ts';

const MAX_ARTIFACT_DATA_BYTES = 16_384;

const MAX_PARAM_DATA_BYTES = 4096;

const MAX_HOOK_LOCAL_STATE_BYTES = 8192;

const MAX_ARRAY_ITEMS = 100;

const MAX_OBJECT_KEYS = 50;

const MAX_PARAMS_JSON_BYTES = 32_768;

const METHOD_PARAM_SCHEMAS: Record<string, import('zod').ZodType<unknown>> = {
  send_message: SendMessageSchema,
  save_artifact: SaveArtifactSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
};

export function boundParams(params: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...params };
  if (clone.data !== undefined) {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(clone.data)).length;
      if (bytes > MAX_PARAM_DATA_BYTES) {
        clone.data = '[truncated: large data field omitted from hook env]';
      }
    } catch {
      clone.data = '[truncated: non-serializable data field]';
    }
  }
  for (const key of Object.keys(clone)) {
    clone[key] = boundValue(clone[key]);
  }
  try {
    const totalBytes = new TextEncoder().encode(JSON.stringify(clone)).length;
    if (totalBytes > MAX_PARAMS_JSON_BYTES) {
      return { _truncated: `params exceed ${MAX_PARAMS_JSON_BYTES} bytes` };
    }
  } catch {
    return { _truncated: 'params are non-serializable' };
  }
  return clone;
}

export function boundValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 4096) {
    return value.slice(0, 4096) + '...[truncated]';
  }
  if (Array.isArray(value)) {
    const arr = value.map((item) => boundValue(item));
    if (arr.length > MAX_ARRAY_ITEMS) {
      return [...arr.slice(0, MAX_ARRAY_ITEMS), '[truncated: array exceeds 100 items]'];
    }
    return arr;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length > MAX_OBJECT_KEYS) {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < MAX_OBJECT_KEYS; i++) {
        const [k, v] = entries[i];
        out[k] = boundValue(v);
      }
      out._truncated = 'object exceeds 50 keys';
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = boundValue(v);
    }
    return out;
  }
  return value;
}

export function boundArtifactData(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (bytes <= MAX_ARTIFACT_DATA_BYTES) return data;
  } catch {}
  return `[truncated: artifact data exceeds ${MAX_ARTIFACT_DATA_BYTES} bytes]`;
}

export function boundHookLocalState(state: Record<string, unknown>): Record<string, unknown> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
    if (bytes <= MAX_HOOK_LOCAL_STATE_BYTES) return state;
  } catch {}
  return { _truncated: `hook local state exceeds ${MAX_HOOK_LOCAL_STATE_BYTES} bytes` };
}

export function validatePatchedParams(
  methodName: string,
  params: Record<string, unknown>
): string[] {
  const schema = METHOD_PARAM_SCHEMAS[methodName];
  if (!schema) return [];
  const result = schema.safeParse(params);
  if (!result.success) {
    return result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'params';
      return `${path}: ${issue.message}`;
    });
  }
  return [];
}

export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
