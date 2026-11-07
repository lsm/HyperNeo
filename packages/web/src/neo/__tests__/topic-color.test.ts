import { describe, expect, it } from 'vitest';
import { neoTopicColor, neoTopicHash } from '../topic-color.ts';

describe('neoTopicHash', () => {
  it.each([
    ['', 0x811c9dc5],
    ['a', 0xe40c292c],
    ['Neo', 0x93243a49],
    ['OAP', 0x42266e87],
    ['Countersign', 0x74af7c0e],
    ['家长控制', 0xfaef4685],
    ['大学申请', 0x2779676d],
    ['邮件', 0xfc642145],
  ])('hashes %j over its UTF-8 bytes', (topic, hash) => {
    expect(neoTopicHash(topic)).toBe(hash);
  });
});

describe('neoTopicColor', () => {
  it.each([
    ['Neo', 'var(--neo-markdown-inline-code)'],
    ['a', 'var(--accent)'],
    ['家长控制', 'var(--neo-teal)'],
    ['Countersign', 'var(--neo-plum)'],
    ['OAP', 'var(--danger)'],
    ['其他', 'var(--fg-faint)'],
  ])('colors %j', (topic, color) => {
    expect(neoTopicColor(topic)).toBe(color);
  });
});
