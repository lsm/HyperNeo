export {
  GitHubEventExtension,
  parseRateLimitHeaders,
  type GitHubRateLimitInfo,
} from './github-event-extension';
export {
  normalizeGitHubWebhook,
  normalizeGitHubPollingRow,
  normalizeGitHubMergeState,
  mapEventType,
  toExternalEvent,
  type GitHubEventKind,
  type NormalizedGitHubEvent,
} from './github-normalizer';
export {
  GitHubEventExtensionRepository,
  type GitHubWatchedRepo,
  type PollCursor,
} from './github-repository';
export {
  classifyMergeStateStatus,
  buildMergeStateQuery,
  parseMergeStateResponse,
  type MergeStateClassification,
  type MergeStateObservation,
} from './merge-state';
export {
  detectStateTransitions,
  type StateTransition,
  type StateObservation,
} from './state-transition';
