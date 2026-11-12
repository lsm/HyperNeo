import type {
  AnthropicMessage,
  ContentBlock,
  ImageBlock,
  TextBlock,
  ToolResultBlock,
} from './types.js';

export interface BridgeImage {
  data: string;
  mediaType: string;
  bytes: number;
}

function imageFromBlock(block: ImageBlock): BridgeImage {
  const source = block.source;
  if (typeof source !== 'object' || source === null) {
    throw new Error('Image block has an invalid source');
  }
  const s = source as Record<string, unknown>;
  if (s['type'] === 'url') {
    throw new Error('Copilot bridge does not support URL image sources');
  }
  if (
    s['type'] === 'base64' &&
    typeof s['media_type'] === 'string' &&
    typeof s['data'] === 'string'
  ) {
    return {
      data: s['data'],
      mediaType: s['media_type'],
      bytes: Buffer.from(s['data'], 'base64').length,
    };
  }
  throw new Error('Image block has an invalid source');
}

export function messageTopLevelImages(msg: AnthropicMessage): BridgeImage[] {
  if (typeof msg.content === 'string') return [];
  const images: BridgeImage[] = [];
  for (const block of msg.content) {
    if (block.type === 'image') images.push(imageFromBlock(block));
  }
  return images;
}

export function collectImages(messages: AnthropicMessage[]): BridgeImage[] {
  const images: BridgeImage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'image') {
        images.push(imageFromBlock(block));
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const part of block.content) {
          if (part.type === 'image') images.push(imageFromBlock(part));
        }
      }
    }
  }
  return images;
}

function toolResultParts(content: string | Array<TextBlock | ImageBlock> | undefined): {
  text: string;
  images: BridgeImage[];
} {
  if (content == null) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };
  const text: string[] = [];
  const images: BridgeImage[] = [];
  for (const b of content) {
    if (b.type === 'image') images.push(imageFromBlock(b));
    else text.push(b.text);
  }
  return { text: text.join('\n'), images };
}

function formatBlocks(blocks: ContentBlock[], role: 'user' | 'assistant', parts: string[]): void {
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text) continue;
      parts.push(role === 'user' ? `[User]: ${block.text}` : `[Assistant]: ${block.text}`);
    } else if (block.type === 'thinking') {
    } else if (block.type === 'tool_use') {
      parts.push(`[Assistant called tool ${block.name} with args: ${JSON.stringify(block.input)}]`);
    } else if (block.type === 'tool_result') {
      const r = block as ToolResultBlock;
      const prefix = r.is_error ? '[Tool error for' : '[Tool result for';
      parts.push(`${prefix} ${r.tool_use_id}]: ${toolResultParts(r.content).text}`);
    } else if (block.type === 'image') {
    }
  }
}

export function formatAnthropicPrompt(messages: AnthropicMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.role === 'user' ? `[User]: ${msg.content}` : `[Assistant]: ${msg.content}`);
    } else {
      formatBlocks(msg.content, msg.role, parts);
    }
  }
  return parts.join('\n\n');
}

export function extractSystemText(system: string | TextBlock[] | undefined): string | undefined {
  if (system == null) return undefined;
  if (typeof system === 'string') return system || undefined;
  const text = system
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  return text || undefined;
}

export function extractToolResultIds(messages: AnthropicMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        ids.push((block as ToolResultBlock).tool_use_id);
      }
    }
  }
  return ids;
}

export function extractToolResultIsError(messages: AnthropicMessage[], toolUseId: string): boolean {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== 'tool_result') continue;
      const r = block as ToolResultBlock;
      if (r.tool_use_id !== toolUseId) continue;
      return r.is_error === true;
    }
  }
  return false;
}

export function extractToolResultParts(
  messages: AnthropicMessage[],
  toolUseId: string
): { text: string; images: BridgeImage[] } | undefined {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== 'tool_result') continue;
      const r = block as ToolResultBlock;
      if (r.tool_use_id !== toolUseId) continue;
      return toolResultParts(r.content);
    }
  }
  return undefined;
}
