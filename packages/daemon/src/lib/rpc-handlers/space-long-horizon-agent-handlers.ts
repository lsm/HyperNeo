import type { MessageHub } from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import {
  registerUnifiedSpaceAgentMethods,
  type UnifiedSpaceAgentRuntimeService,
} from './space-agent-handlers.ts';

export function setupSpaceLongHorizonAgentHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  repo: SpaceLongHorizonAgentRepository,
  spaceAgentManager?: SpaceAgentManager,
  runtimeService?: UnifiedSpaceAgentRuntimeService,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): void {
  registerUnifiedSpaceAgentMethods(messageHub, 'spaceLongHorizonAgent', {
    spaceManager,
    repo,
    spaceAgentManager,
    runtimeService,
    internalEventBus,
  });
}
