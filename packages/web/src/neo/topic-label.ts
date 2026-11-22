import { NEO_OTHER_TOPIC_KEY, shortenNeoTopic, type NeoAsk } from '@hyperneo/shared/types/neo-ask';
import { isMessageKey, locale, t } from '../lib/i18n/index.ts';

export function neoTopicLabel({
  topic,
  topicKey,
  topicSource,
}: Pick<NeoAsk, 'topic' | 'topicSource'> & { topicKey?: string | null }): string | null {
  if (topicKey === NEO_OTHER_TOPIC_KEY) return t('queue.topic.other');
  if (!topic || !topicSource) return topic;
  if (locale.value === 'zh-Hans' && topicSource === 'project') {
    const glossary = `queue.topic.glossary.${topic.toLowerCase()}`;
    if (isMessageKey(glossary)) return t(glossary);
    if (
      /\p{Script=Latin}/u.test(topic) &&
      !/\p{Script=Han}/u.test(topic) &&
      !/^[A-Z][A-Z0-9]*$/.test(topic)
    ) {
      return t('queue.topic.project');
    }
  }
  return shortenNeoTopic(topic);
}
