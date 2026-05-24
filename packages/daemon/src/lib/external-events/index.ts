/**
 * External Event Bus — public exports.
 *
 * Source-agnostic primitives consumed by extension publishers, the
 * `ExternalEventService`, the workflow runtime, and tests. GitHub-specific
 * code lives under `./github` (added in a later task).
 */

export {
  type ExternalEvent,
  type ExternalEventState,
  type ExternalEventDeliveryState,
  type ExternalEventRecord,
  type ExternalEventDeliveryRecord,
  type DeliveryFailure,
  type DeliveryTarget,
  type StoreResult,
  type ExternalEventExtensionConfig,
  type SpaceExternalEventSourceConfig,
  type ExternalEventExtensionContext,
  type ExternalEventExtensionConfigStore as ExternalEventExtensionConfigStoreContract,
  type ExternalEventExtension,
  type Route,
  type HttpExternalEventExtension,
  type RpcExternalEventExtension,
  TERMINAL_EVENT_STATES,
  TERMINAL_DELIVERY_STATES,
} from './types';
export {
  validateGlobPattern,
  validateSource,
  KNOWN_SOURCES,
  type ValidationResult,
} from './topic-validator';
export {
  ExternalEventStore,
  ExternalEventValidationError,
} from './external-event-store';
export {
  ExternalEventService,
  type ExternalEventPublisher,
  type PublishResult,
  type PublishOutcome,
  type ExternalEventPublishedPayload,
} from './external-event-service';
export { TopicTrie, isReceivingStatus } from './topic-trie';
export {
  ExternalEventExtensionConfigStore,
  ensureExternalEventExtensionConfigTables,
} from './extension-config-store';
export {
  ExternalEventExtensionManager,
  type RegisteredRoute,
} from './extension-manager';
