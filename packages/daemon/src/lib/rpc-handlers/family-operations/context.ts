import type { NeoWorkerNameSource } from '../../neo/worker-name.ts';
import type { createClaudeInboxDriver } from '../../drivers/claude-inbox-driver.ts';
import type { createClaudeDesktopModsDriver } from '../../drivers/claude-desktop-mods-driver.ts';
import type { WorkExecutionPreparation } from '../../drivers/start-preparation.ts';
import type { RPCHandlerDependencies } from '../index.ts';
import type { SessionScheduler } from '../../scheduler/session-schedules.ts';
import type { NeoPack } from '../../neo/pack-contract.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import type { DaemonAdapterHost } from '../../extensions/contract.ts';
import type { Session, Space } from '@hyperneo/shared';
import type { AgentSession } from '../../agent/agent-session.ts';
import type { OperationCallerRole } from '../../operations/registry.ts';

export interface SessionSpacePort {
  sessionSpaceId(session: Session): string | undefined;
  resolveRole(session: Session): OperationCallerRole;
  getSpace(spaceId: string): Promise<Space | null>;
  addSession(spaceId: string, sessionId: string): Promise<unknown>;
  attachTools(sessionId: string): Promise<void>;
  liveSession(sessionId: string): AgentSession | undefined;
  isRuntimeSettingsPreparing(sessionId: string): boolean;
}

export interface FamilyOperationContext {
  readonly workerNameSource?: (read: NeoWorkerNameSource) => void;
  readonly driverHealthNotice?: (id: string, text: string) => Promise<boolean>;
  readonly driverCleanup?: (() => Promise<void>)[];
  readonly sessionScheduler: SessionScheduler;
  readonly goalMandateChange?: (ref: string, revision: string | null) => Promise<string | null>;
  readonly neoPacks: () => readonly NeoPack[];
  readonly extensionAdapters?: (host: DaemonAdapterHost) => readonly WorkAdapter[];
  readonly claudeInbox?: ReturnType<typeof createClaudeInboxDriver>;
  readonly claudeDesktopMods?: ReturnType<typeof createClaudeDesktopModsDriver>;
  readonly executionPreparations?: () => readonly {
    id: string;
    prepareExecution?: WorkExecutionPreparation;
  }[];
  readonly deps: RPCHandlerDependencies;
  readonly sessionSpace?: SessionSpacePort;
}
