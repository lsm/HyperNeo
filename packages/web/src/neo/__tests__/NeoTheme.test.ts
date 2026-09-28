import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const neoCss = readFileSync(resolve(__dirname, '../neo.css'), 'utf8');

function luminance(token: string, theme: number): number {
  const match = neoCss.match(
    new RegExp(`${token}: light-dark\\((#[a-f\\d]{6}), (#[a-f\\d]{6})\\)`)
  );
  if (!match) throw new Error(`Missing palette token: ${token}`);
  return [1, 3, 5]
    .map((offset) => parseInt(match[theme + 1].slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

describe.each(['light', 'dark'])('Neo %s palette contrast', (theme) => {
  it.each([
    ['--fg-muted', '--bg'],
    ['--fg-faint', '--bg'],
    ['--fg-muted', '--surface'],
    ['--fg-faint', '--surface'],
    ['--fg-muted', '--surface-overlay'],
    ['--fg-faint', '--surface-overlay'],
    ['--fg-muted', '--surface-raised'],
    ['--fg-faint', '--surface-raised'],
    ['--accent-fg', '--accent'],
    ['--accent-fg', '--accent-hover'],
  ])('keeps %s on %s readable for small text', (foreground, background) => {
    const index = theme === 'light' ? 0 : 1;
    const values = [luminance(foreground, index), luminance(background, index)];
    const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
