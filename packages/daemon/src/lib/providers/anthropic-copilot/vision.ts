import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';
import type { BridgeImage } from './prompt.js';

const MODEL_TTL_MS = 10 * 60_000;

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
  return async (model: string, images: readonly BridgeImage[]): Promise<string | null> => {
    if (images.length === 0) return null;
    const info = await models()
      .then((m) => m.get(model))
      .catch(() => undefined);
    if (!info) {
      return `Model '${model}' cannot be verified for image input; only base64 images to vision-capable models are supported`;
    }
    if (!info.capabilities?.supports?.vision) {
      return `Model '${model}' does not support vision input; image content blocks cannot be sent`;
    }
    const vision = info.capabilities.limits?.vision;
    if (!vision) return null;
    if (images.length > vision.max_prompt_images) {
      return `Model '${model}' accepts at most ${vision.max_prompt_images} images per request (${images.length} provided)`;
    }
    for (const image of images) {
      if (!mediaTypeMatches(vision.supported_media_types, image.mediaType)) {
        return `Model '${model}' does not support image media type '${image.mediaType}'; supported: ${vision.supported_media_types.join(', ')}`;
      }
      if (image.bytes > vision.max_prompt_image_size) {
        return `Image exceeds the per-image size limit for model '${model}': ${image.bytes} bytes > ${vision.max_prompt_image_size} bytes`;
      }
    }
    return null;
  };
}
