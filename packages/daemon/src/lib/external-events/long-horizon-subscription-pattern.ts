/**
 * Long-horizon subscription topic composition — pure helper that joins a
 * subscription `source` and `topic` into a glob subscription pattern, branching
 * to the GitHub topic grammar ({@link composeGitHubSubscriptionPattern}) when
 * the source is `github`.
 *
 * Canonical home. This helper was previously duplicated verbatim in
 * {@link file://./../space/runtime/space-runtime.ts} (reactive subscription
 * wiring) and {@link file://./../rpc-handlers/space-long-horizon-agent-handlers.ts}
 * (long-horizon agent CRUD); both now import from here.
 *
 * Narrow capability surface: {@link composeLongHorizonSubscriptionPattern}.
 *
 * Dependency direction: downward only — `KNOWN_SOURCES` from
 * {@link ./topic-validator} and the GitHub branch from
 * {@link ./github-subscription-pattern}.
 */

import { composeGitHubSubscriptionPattern } from './github-subscription-pattern';
import { KNOWN_SOURCES } from './topic-validator';

/**
 * Compose a glob subscription pattern from a subscription `source` and `topic`.
 *
 * - An empty source returns the (trimmed) topic unchanged.
 * - When the source is `github`, GitHub owner/repo shorthand and source-prefixed
 *   topics delegate to {@link composeGitHubSubscriptionPattern}.
 * - A non-github topic whose first segment already equals the source is returned
 *   unchanged.
 * - Otherwise the topic's leading segment must not be a known source that
 *   disagrees with `source` (throws); the result is `source/topic`.
 */
export function composeLongHorizonSubscriptionPattern(source: string, topic: string): string {
  const trimmedSource = source.trim();
  const trimmedTopic = topic.trim();
  if (!trimmedSource) return trimmedTopic;
  const topicSource = trimmedTopic.split('/')[0] ?? '';
  if (trimmedSource === 'github') {
    const segments = trimmedTopic.split('/');
    const isOwnerRepoShorthand =
      segments.length === 3 ||
      segments.length === 4 ||
      (segments[0] === trimmedSource && (segments.length === 3 || segments.length === 4));
    if (isOwnerRepoShorthand || topicSource === trimmedSource) {
      return composeGitHubSubscriptionPattern(trimmedSource, trimmedTopic);
    }
  } else if (topicSource === trimmedSource) {
    return trimmedTopic;
  }
  const normalizedTopicSource = topicSource.toLowerCase();
  if (
    normalizedTopicSource === trimmedSource.toLowerCase() ||
    KNOWN_SOURCES.has(normalizedTopicSource)
  ) {
    throw new Error(`Topic source "${topicSource}" does not match source "${trimmedSource}"`);
  }
  if (trimmedSource === 'github')
    return composeGitHubSubscriptionPattern(trimmedSource, trimmedTopic);
  return `${trimmedSource}/${trimmedTopic}`;
}
