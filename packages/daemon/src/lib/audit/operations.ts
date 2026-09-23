import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
  type OperationPolicy,
} from '../operations/registry.ts';
import {
  admitSpaceCaller,
  type SpaceCallerAdmission,
  type SpaceCallerRejection,
} from '../operations/space-caller-admission.ts';
import { queryAuditEntriesPage, type AuditEntryView } from './list-audit-entries.ts';

export interface AuditOperationDependencies {
  readonly auditLogRepo: McpAuditLogRepository;
}

const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  agentName: z.string().nullable(),
  sessionId: z.string().nullable(),
  toolName: z.string(),
  paramsSummary: z.string().nullable(),
  spaceId: z.string().nullable(),
  taskId: z.string().nullable(),
  workflowRunId: z.string().nullable(),
}) satisfies z.ZodType<AuditEntryView>;

const AuditRejectionSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['space_scope_required', 'space_mismatch', 'denied', 'rejected']),
  message: z.string(),
});

const AuditListResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    entries: z.array(AuditEntrySchema),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  }),
  AuditRejectionSchema,
]);

const SpaceScopeSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Space to act in. Ignored for agents, whose Space comes from their session.');

const AuditListInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    taskId: z.string().min(1).optional().describe('Filter entries to one task.'),
    sessionId: z.string().min(1).optional().describe('Filter entries to one session.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of entries to return (default 20, max 100).'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Number of entries to skip for pagination (default 0).'),
  })
  .strict();

type AuditRejection = z.infer<typeof AuditRejectionSchema>;
type AuditListResult = z.infer<typeof AuditListResultSchema>;
type AuditListInput = z.infer<typeof AuditListInputSchema>;

const SCOPE_MESSAGES: Record<SpaceCallerRejection, string> = {
  space_scope_required: 'A Space is required: pass spaceId, or call from a session inside a Space.',
  space_mismatch: 'The requested spaceId does not match the calling session Space.',
  denied: 'This caller may not read the Space audit log.',
};

function reject(reason: AuditRejection['reason'], message: string): AuditRejection {
  return { ok: false, reason, message };
}

export function resolveAuditScope(
  input: { spaceId?: string },
  caller: OperationCaller,
  admission: SpaceCallerAdmission
): { value: string } | { reason: AuditRejection } {
  const scope = admitSpaceCaller(caller, input.spaceId, admission);
  return 'value' in scope ? scope : { reason: reject(scope.reason, SCOPE_MESSAGES[scope.reason]) };
}

export function listAuditEntriesPage(
  spaceId: string,
  input: AuditListInput,
  deps: AuditOperationDependencies
): AuditListResult {
  try {
    const page = queryAuditEntriesPage(deps.auditLogRepo, spaceId, {
      task_id: input.taskId,
      session_id: input.sessionId,
      limit: input.limit,
      offset: input.offset,
    });
    return { ok: true, entries: page.entries, total: page.total, hasMore: page.has_more };
  } catch (err) {
    return reject('rejected', err instanceof Error ? err.message : String(err));
  }
}

const READ_ADMISSION: SpaceCallerAdmission = { readOnly: true };

const READ_ROLES: readonly OperationCallerRole[] = [
  'ad_hoc_member',
  'long_term_agent',
  'workflow_worker',
];

const READ_POLICY: OperationPolicy = { safetyClass: 'read', roles: READ_ROLES };

const SCOPE_NOTE =
  'Human (RPC) callers pass spaceId; agent (MCP) callers inherit the Space of their own session and may not override it.';

export function createAuditOperations(deps: AuditOperationDependencies): OperationDefinition[] {
  const list = (superpipe({ deps, admission: READ_ADMISSION })('space-audit-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveAuditScope, ['input', 'caller', 'admission'], 'result:outcome')
    .pipe(listAuditEntriesPage, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: AuditListInput,
    caller: OperationCaller
  ) => Promise<AuditListResult>;

  return [
    defineOperation({
      name: 'space.audit.list',
      policy: READ_POLICY,
      description:
        `List the Space tool-audit log (recorded MCP tool invocations), newest first, with caller agent, session, tool name, and parameter summary per entry. ` +
        `taskId narrows to one task and sessionId to one session; when both are given taskId wins. ` +
        `limit defaults to 20 (max 100) and offset pages; total counts every entry matching the filter and hasMore reports whether another page remains. ` +
        `${SCOPE_NOTE} ` +
        `Returns the page, or a rejection: denied for callers without Space read access, space_scope_required or space_mismatch for scope problems, rejected when the audit query fails.`,
      inputSchema: AuditListInputSchema,
      resultSchema: AuditListResultSchema,
      execute: (input, caller) => list(input, caller),
    }),
  ];
}
