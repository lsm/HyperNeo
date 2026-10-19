import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  isNeoUnattendedCleanup,
  type NeoProjectCleanup,
  type NeoProjectFacts,
  type NeoRetiredHolder,
  neoCleanupFolders,
  planNeoProjectCleanup,
} from './project-cleanup.ts';
import { NEO_INBOX_ID } from './inbox.ts';

const Input = z
  .object({ apply: z.boolean().optional(), archive: z.array(z.string()).optional() })
  .default({});
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
    merged: z.array(z.object({ sourceId: z.string(), targetId: z.string() })),
    cleanupPlanned: z.array(
      z.object({
        action: z.enum(['delete', 'merge', 'archive', 'drop']),
        sessionId: z.string().optional(),
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
type Merged = { sourceId: string; targetId: string };

export interface NeoReorganizeRuntime {
  getBinding(sessionId: string): NeoBinding | null;
  rootSessionId(): string | null;
  sessionStatus(sessionId: string): string | null;
  mergeProjects(): Promise<{ merged: Merged[] }>;
  projectFacts(): NeoProjectFacts[];
  machine(): string;
  retiredHolders(): NeoRetiredHolder[];
  cleanup(step: NeoProjectCleanup): Promise<void>;
  mirroredAliases(folders: readonly string[]): Promise<ReadonlySet<string> | null>;
  log(line: string): void;
}

export function admitNeoReorganizer(
  caller: OperationCaller,
  binding: NeoBinding | null
): { value: true } | { reason: Outcome } {
  return (caller.source === 'rpc' && caller.principal === 'local') ||
    (caller.source === 'mcp' && (binding?.kind === 'neo' || binding?.projectId === NEO_INBOX_ID))
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
  merged: Merged[];
  cleanupPlanned: NeoProjectCleanup[];
  cleanupApplied: boolean;
  cleanupFailed: { projectId: string; reason: string }[];
};

export function createNeoProjectsReorganizer(
  runtime: NeoReorganizeRuntime
): (cleanup?: {
  apply?: boolean | 'unattended';
  archive?: readonly string[];
}) => Promise<NeoReorganized> {
  const planNeoProjectCleanupNow = (
    mirrored: ReadonlySet<string>,
    archive: readonly string[]
  ): NeoProjectCleanup[] => {
    const projects = runtime.projectFacts();
    const retired = runtime.retiredHolders();
    const holders = [
      ...projects.flatMap((project) => project.holder ?? []),
      ...retired.map((holder) => holder.sessionId),
    ];
    return planNeoProjectCleanup(projects, {
      pinned: new Set([NEO_INBOX_ID]),
      machine: runtime.machine(),
      mirrored,
      archive: new Set(archive),
      retired,
      busy: new Set(
        holders.filter((id) => !['idle', 'interrupted', null].includes(runtime.sessionStatus(id)))
      ),
    });
  };
  return async ({ apply = false, archive = [] } = {}) => {
    const mirrored = await runtime.mirroredAliases(
      neoCleanupFolders(runtime.projectFacts(), runtime.machine())
    );
    const { merged } = await runtime.mergeProjects();
    for (const merge of merged)
      runtime.log(`neo reorganize: merged project ${merge.sourceId} into ${merge.targetId}`);
    if (!mirrored) runtime.log('neo reorganize: no project cleanup, the places could not be read');
    const cleanupPlanned = mirrored ? planNeoProjectCleanupNow(mirrored, archive) : [];
    const cleanupFailed: { projectId: string; reason: string }[] = [];
    let cleanupRan = false;
    for (const step of cleanupPlanned) {
      const line = `${step.action} project ${step.projectId} (${step.title})${'targetId' in step ? ` into ${step.targetId}` : ''}${'sessionId' in step ? ` holder ${step.sessionId}` : ''}`;
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
      merged,
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
      'Merge sibling projects whose code identity matches (the older one stays; old links and conversations of the merged one keep working). Sibling projects that share a repository but whose identity cannot be read stay separate. Then move each live ask into the project it belongs to: main’s asks into their projects, and a project’s off-project asks into the right project, an existing one or a new project and avatar the daemon creates. The ask and its cards are handed to that project’s avatar with a note, and replies still resolve to the human’s original message. Asks waiting on the human or blocked on them, asks that changed while routing, one-off asks, asks the router keeps where they are, and asks whose current or target avatar is mid-turn are left in place. Nothing is shown to the human; every move is logged. It also plans project cleanup and returns it in cleanupPlanned; it applies it only with apply: true, and the daily pass applies every step except merges on its own, and leaves merges for a run with apply: true. Repository projects are left to the merge above. A project with no repository is deleted when empty and the mirror would not create it again, merged into the repository project where most of its cards ran (else one with its title), and otherwise kept. Projects named in archive, as the human asked, have their holder session archived; history stays. When a project is merged away, its holder session is deleted if it never spoke and archived if it has history; a holder mid-turn waits for a later pass. A project only on another machine is deleted when empty and otherwise left alone. It also runs on its own about once a day, after the human has been away for three hours. Main Neo, the default session or the human only.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => reorganize(input, caller),
  });
}
