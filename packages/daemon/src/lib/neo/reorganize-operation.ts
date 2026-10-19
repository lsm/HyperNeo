import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  isNeoUnattendedCleanup,
  type NeoProjectCleanup,
  type NeoProjectFacts,
  neoCleanupFolders,
  planNeoProjectCleanup,
} from './project-cleanup.ts';
import { NEO_INBOX_ID } from './inbox.ts';

const Input = z.object({ apply: z.boolean().optional() }).default({});
const Stayed = z.object({
  askId: z.string(),
  reason: z.enum([
    'waiting_on_human',
    'changed',
    'stays_main',
    'in_place',
    'one_off',
    'project_busy',
    'handoff_failed',
  ]),
});
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.literal('main_neo_only') }),
  z.object({
    ok: z.literal(true),
    cleanupPlanned: z.array(
      z.object({
        action: z.enum(['delete', 'merge']),
        projectId: z.string(),
        title: z.string(),
        targetId: z.string().optional(),
      })
    ),
    cleanupApplied: z.boolean(),
    cleanupFailed: z.array(z.object({ projectId: z.string(), reason: z.string() })),
  }),
]);
type Stay = z.infer<typeof Stayed>;
type Outcome = z.infer<typeof Result>;
type Project = { projectId: string; sessionId: string };

export interface NeoReorganizeRuntime {
  getBinding(sessionId: string): NeoBinding | null;
  rootSessionId(): string | null;
  recordIdentities(): Promise<void>;
  projectFacts(): NeoProjectFacts[];
  machine(): string;
  cleanup(step: NeoProjectCleanup): Promise<void>;
  mirroredAliases(folders: readonly string[]): Promise<ReadonlySet<string> | null>;
  log(line: string): void;
}

export function admitNeoReorganizer(
  caller: OperationCaller,
  binding: NeoBinding | null
): { value: true } | { reason: Outcome } {
  return (caller.source === 'rpc' && caller.principal === 'local') ||
    (caller.source === 'mcp' && binding?.kind === 'neo')
    ? { value: true }
    : { reason: { ok: false, reason: 'main_neo_only' } };
}

export type NeoRouted = { choice: { projectId: string; sessionId: string } | null };

export function requireNeoAskProject(
  ask: NeoAsk,
  routed: NeoRouted
): { value: Project } | { reason: Stay } {
  const choice = routed.choice;
  const home = ask.projectId === null ? null : 'in_place';
  if (!choice) return { reason: { askId: ask.id, reason: home ?? 'stays_main' } };
  if (choice.projectId === NEO_INBOX_ID)
    return { reason: { askId: ask.id, reason: home ?? 'one_off' } };
  if (choice.projectId === ask.projectId) return { reason: { askId: ask.id, reason: 'in_place' } };
  return { value: { projectId: choice.projectId, sessionId: choice.sessionId } };
}

export type NeoReorganized = {
  cleanupPlanned: NeoProjectCleanup[];
  cleanupApplied: boolean;
  cleanupFailed: { projectId: string; reason: string }[];
};

export function createNeoProjectsReorganizer(
  runtime: NeoReorganizeRuntime
): (cleanup?: { apply?: boolean | 'unattended' }) => Promise<NeoReorganized> {
  const planNeoProjectCleanupNow = (mirrored: ReadonlySet<string>): NeoProjectCleanup[] =>
    planNeoProjectCleanup(runtime.projectFacts(), {
      pinned: new Set([NEO_INBOX_ID]),
      machine: runtime.machine(),
      mirrored,
    });
  return async ({ apply = false } = {}) => {
    const mirrored = await runtime.mirroredAliases(
      neoCleanupFolders(runtime.projectFacts(), runtime.machine())
    );
    await runtime.recordIdentities();
    if (!mirrored) runtime.log('neo reorganize: no project cleanup, the places could not be read');
    const cleanupPlanned = mirrored ? planNeoProjectCleanupNow(mirrored) : [];
    const cleanupFailed: { projectId: string; reason: string }[] = [];
    let cleanupRan = false;
    for (const step of cleanupPlanned) {
      const line = `${step.action} project ${step.projectId} (${step.title})${'targetId' in step ? ` into ${step.targetId}` : ''}`;
      if (apply === 'unattended' && !isNeoUnattendedCleanup(step)) {
        runtime.log(`neo reorganize: left for apply: true: ${line}`);
        continue;
      }
      if (!apply) {
        runtime.log(`neo reorganize: would ${line}`);
        continue;
      }
      cleanupRan = true;
      const reason = await runtime.cleanup(step).then(
        () => null,
        (error: unknown) => String(error)
      );
      if (reason) cleanupFailed.push({ projectId: step.projectId, reason });
      runtime.log(
        reason ? `neo reorganize: could not ${line}: ${reason}` : `neo reorganize: did ${line}`
      );
    }
    return {
      cleanupPlanned,
      cleanupApplied: apply === true || cleanupRan,
      cleanupFailed,
    };
  };
}

export function createNeoReorganizeOperation(runtime: NeoReorganizeRuntime) {
  const reorganizeProjects = createNeoProjectsReorganizer(runtime);
  const reorganize = async (
    cleanup: z.infer<typeof Input>,
    caller: OperationCaller
  ): Promise<Outcome> => {
    const admitted = admitNeoReorganizer(
      caller,
      caller.sessionId ? runtime.getBinding(caller.sessionId) : null
    );
    if ('reason' in admitted) return admitted.reason;
    return { ok: true, ...(await reorganizeProjects(cleanup)) };
  };

  return defineOperation({
    name: 'neo.projects.reorganize',
    description:
      'Merge sibling projects whose code identity matches (the older one stays; old links and conversations of the merged one keep working). Sibling projects that share a repository but whose identity cannot be read stay separate. Nothing is shown to the human; every merge is logged. It also plans project cleanup and returns it in cleanupPlanned; it applies it only with apply: true, and the daily pass applies every step except merges on its own, and leaves merges for a run with apply: true. Repository projects are left to the merge above. A project with no repository is deleted when empty and the mirror would not create it again, merged into the repository project where most of its cards ran (else one with its title), and otherwise kept. A project only on another machine is deleted when empty and otherwise left alone. It also runs on its own about once a day, after the human has been away for three hours. Main Neo, the default session or the human only.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => reorganize(input, caller),
  });
}
