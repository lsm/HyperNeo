import { mkdir } from 'node:fs/promises';
import { stripComments } from './strip-comments.ts';

const SDK_TYPE_FILES = ['sdk.d.ts', 'sdk-tools.d.ts'] as const;

export function prepareSdkTypeFile(source: string, name: (typeof SDK_TYPE_FILES)[number]): string {
  const upstream = `packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/${name}`;
  const destination = `packages/shared/src/sdk/${name}`;
  return `// Upstream SDK documentation: ${upstream}\n${stripComments(source, destination, false)}`;
}

if (import.meta.main) {
  await mkdir('packages/shared/src/sdk', { recursive: true });
  for (const name of SDK_TYPE_FILES) {
    const source = await Bun.file(
      `packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/${name}`
    ).text();
    await Bun.write(`packages/shared/src/sdk/${name}`, prepareSdkTypeFile(source, name));
  }
}
