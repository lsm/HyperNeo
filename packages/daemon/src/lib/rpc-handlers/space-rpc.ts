import type { OperationDefinition } from '../operations/registry.ts';
import type { SessionReportHandler } from '../messaging/message-send.ts';
import type { FamilyOperationContext, SessionSpacePort } from './family-operations/context.ts';
import type { RPCHandlerDependencies } from './index.ts';
import type { SessionHandlerDeps, SessionSpaceMembership } from './session-handlers.ts';
import type { createNeoCodingReaders } from '../neo/packs/runtime.ts';

type CodingReaders = ReturnType<typeof createNeoCodingReaders>;

export interface SpaceRpcHost {
  readGithubPr: CodingReaders['readConnectorPr'];
  readGithubReviewThreads: CodingReaders['readReviewThreads'];
}

export interface SpaceRpc<SpaceServices> {
  services: SpaceServices;
  sessionSpace: SessionSpacePort;
  membership: SessionSpaceMembership;
  ensureSession: SessionHandlerDeps['ensureSession'];
  resolveClones: SessionHandlerDeps['resolveClones'];
  primaryAgentFor: NonNullable<SessionHandlerDeps['primaryAgentFor']>;
  familyOperations(core: FamilyOperationContext): OperationDefinition[];
  complete(
    familyOperations: readonly OperationDefinition[],
    handleWorkerQuestion: SessionReportHandler,
    readPrState: (prUrl: string) => ReturnType<CodingReaders['readPrState']>
  ): void;
  stop(): Promise<void>;
}

export type SpaceRpcFactory<SpaceServices> = (
  deps: RPCHandlerDependencies,
  host: SpaceRpcHost
) => Promise<SpaceRpc<SpaceServices>>;
