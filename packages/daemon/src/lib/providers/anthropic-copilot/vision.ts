import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';
import type { BridgeImage } from './prompt.js';

const MODEL_TTL_MS = 10 * 60_000;

export type VisionFit = { error: string } | { keepFrom: number; limit: number };

export function omittedImageText(limit: number): string {
  return `[earlier image omitted: model accepts at most ${limit} images per request]`;
}

function mediaTypeMatches(supported: string[], mediaType: string): boolean {
  return supported.some((s) => s === mediaType || s === 'image/*' || s === '*/*');
}

export function createVisionGate(client: CopilotClient, now: () => number = Date.now) {
  let cached: { at: number; models: Promise<Map<string, ModelInfo>> } | undefined;
  const models = () => {
    if (!cached || now() - cached.at > MODEL_TTL_MS) {
      const pending = client.listModels().then((list) => new Map(list.map((m) => [m.id, m])));
      cached = { at: now(), models: pending };
      pending.catch(() => {
        if (cached?.models === pending) cached = undefined;
      });
    }
    return cached.models;
  };
  return async (model: string, images: readonly BridgeImage[]): Promise<VisionFit> => {
    const all = { keepFrom: 0, limit: images.length };
    if (images.length === 0) return all;
    const info = await models()
      .then((m) => m.get(model))
      .catch(() => undefined);
    if (!info?.capabilities) return all;
    if (!info.capabilities.supports?.vision) {
      return {
        error: `Model '${model}' does not support vision input; image content blocks cannot be sent`,
      };
    }
    const vision = info.capabilities.limits?.vision;
    if (!vision) return all;
    const limit = vision.max_prompt_images;
    const keepFrom = Math.max(0, images.length - limit);
    for (const image of images.slice(keepFrom)) {
      if (!mediaTypeMatches(vision.supported_media_types, image.mediaType)) {
        return {
          error: `Model '${model}' does not support image media type '${image.mediaType}'; supported: ${vision.supported_media_types.join(', ')}`,
        };
      }
      if (image.bytes > vision.max_prompt_image_size) {
        return {
          error: `Image exceeds the per-image size limit for model '${model}': ${image.bytes} bytes > ${vision.max_prompt_image_size} bytes`,
        };
      }
    }
    return { keepFrom, limit };
  };
}
