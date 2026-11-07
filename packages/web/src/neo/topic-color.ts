const palette = [
  'var(--neo-markdown-strong)',
  'var(--neo-markdown-inline-code)',
  'var(--neo-markdown-link)',
  'var(--neo-user-accent)',
  'var(--accent)',
  'var(--neo-teal)',
  'var(--neo-plum)',
  'var(--danger)',
];

export const NEO_OTHER_TOPIC = '其他';

export function neoTopicHash(topic: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(topic)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

export function neoTopicColor(topic: string): string {
  return topic === NEO_OTHER_TOPIC ? 'var(--fg-faint)' : palette[neoTopicHash(topic) % 8];
}
