import type { NeoAttachment } from './neo-attachments.ts';

export type NeoFlightRect = { x: number; y: number; width: number; height: number };

export type NeoFlightOrigin = NeoFlightRect & {
  media?: { target: string; from: NeoFlightRect; file: NeoAttachment }[];
};

export function neoFlightBox(from: NeoFlightRect, to: NeoFlightRect, progress: number) {
  if (progress <= 0)
    return { x: from.x, y: from.y, width: from.width, height: from.height, chrome: 0 };
  if (progress >= 1) return { x: to.x, y: to.y, width: to.width, height: to.height, chrome: 1 };
  const cubic = (t: number, a: number, b: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const middle = (low + high) / 2;
    if (cubic(middle, 0.4, 0.2) < progress) low = middle;
    else high = middle;
  }
  const t = cubic((low + high) / 2, 0, 1);
  const u = 1 - t;
  const width = from.width * u + to.width * t;
  const height = from.height * u + to.height * t;
  const startX = from.x + from.width / 2;
  const endX = to.x + to.width / 2;
  return {
    x: u * u * startX + 2 * u * t * (Math.max(startX, endX) + 24) + t * t * endX - width / 2,
    y: (from.y + from.height / 2) * u + (to.y + to.height / 2) * t - height / 2,
    width,
    height,
    chrome: t,
  };
}
