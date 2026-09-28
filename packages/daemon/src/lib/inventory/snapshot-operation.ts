import type { DaemonInventoryPage, DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

const InputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    includeArchived: z.boolean().default(false),
  })
  .strict()
  .default({ limit: 20, includeArchived: false });
type SnapshotInput = z.infer<typeof InputSchema>;
const EntrySchema = z.object({
  id: z.string(),
  name: z.string().max(160),
  status: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
  workspacePath: z.string().nullable(),
  links: z.array(z.object({ kind: z.string(), id: z.string() })),
});
const PageSchema = z
  .object({
    kind: z.string(),
    total: z.number().int().nonnegative(),
    entries: z.array(EntrySchema).max(50),
    truncated: z.boolean(),
  })
  .refine((page) => page.total >= page.entries.length);
const SnapshotSchema = z.object({
  capturedAt: z.number().int().nonnegative(),
  resources: z.array(PageSchema),
  capabilities: z.array(z.string()),
}) satisfies z.ZodType<DaemonSnapshot>;

export interface InventoryDependencies {
  readonly readResources: (
    input: SnapshotInput
  ) => readonly DaemonInventoryPage[] | Promise<readonly DaemonInventoryPage[]>;
  readonly readCapabilities: (
    caller: OperationCaller
  ) => readonly string[] | Promise<readonly string[]>;
  readonly now?: () => number;
}

export function presentDaemonSnapshot(
  resources: readonly DaemonInventoryPage[],
  capabilities: readonly string[],
  capturedAt: number,
  limit = 50
): DaemonSnapshot {
  return {
    capturedAt,
    resources: resources.map((page) => ({
      kind: page.kind,
      total: page.total,
      truncated: page.total > Math.min(page.entries.length, limit),
      entries: [...page.entries]
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.id,
          name: entry.name.slice(0, 160),
          status: entry.status,
          updatedAt: entry.updatedAt,
          workspacePath: entry.workspacePath,
          links: entry.links.map(({ kind, id }) => ({ kind, id })),
        })),
    })),
    capabilities: [...new Set(capabilities)].sort(),
  };
}

export function createDaemonSnapshotOperation(deps: InventoryDependencies) {
  const snapshot = (
    superpipe({ ...deps, now: deps.now ?? Date.now })('daemon-snapshot') as PipelineAPI
  )
    .input(['input', 'caller'])
    .pipe((input: SnapshotInput) => input.limit, 'input', 'limit')
    .pipe((now: () => number) => now(), 'now', 'capturedAt')
    .pipe(
      (input: SnapshotInput, read: InventoryDependencies['readResources']) => read(input),
      ['input', 'readResources'],
      'resources'
    )
    .pipe(
      (caller: OperationCaller, read: InventoryDependencies['readCapabilities']) => read(caller),
      ['caller', 'readCapabilities'],
      'capabilities'
    )
    .pipe(presentDaemonSnapshot, ['resources', 'capabilities', 'capturedAt', 'limit'], 'snapshot')
    .endAsync('snapshot') as (
    input: SnapshotInput,
    caller: OperationCaller
  ) => Promise<DaemonSnapshot>;
  return defineOperation({
    name: 'daemon.snapshot',
    description:
      'Read local daemon resource metadata and caller-visible operation names without opening sessions or executing work. Each resource kind returns at most limit entries, newest first, with an exact total and an explicit truncated flag. Session status is lifecycle state, not live processing progress. No instructions, configs or transcripts are included. Use operations.describe for capability schemas.',
    policy: { safetyClass: 'read' },
    inputSchema: InputSchema,
    resultSchema: SnapshotSchema,
    execute: snapshot,
  });
}
