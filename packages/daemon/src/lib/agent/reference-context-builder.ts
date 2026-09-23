import type { ResolvedReference } from '@hyperneo/shared';
import { Logger } from '../logger.ts';

const log = new Logger('reference-context-builder');

export const MAX_CONTEXT_BYTES = 200_000;

const PRIORITY_ORDER: ReadonlyArray<ResolvedReference['type']> = ['file', 'folder'];

export function buildReferenceContext(references: Record<string, ResolvedReference>): string {
  const entries = Object.values(references);
  if (entries.length === 0) {
    return '';
  }

  const sorted = [...entries].sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(a.type);
    const pb = PRIORITY_ORDER.indexOf(b.type);
    const ra = pa === -1 ? PRIORITY_ORDER.length : pa;
    const rb = pb === -1 ? PRIORITY_ORDER.length : pb;
    return ra - rb;
  });

  const sections: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const ref of sorted) {
    const section = formatReference(ref);
    if (!section) {
      continue;
    }
    const sectionBytes = Buffer.byteLength(section, 'utf8');
    if (totalBytes + sectionBytes > MAX_CONTEXT_BYTES) {
      truncated = true;
      break;
    }
    sections.push(section);
    totalBytes += sectionBytes;
  }

  if (truncated) {
    log.warn(
      `Reference context truncated at ${totalBytes} bytes (limit: ${MAX_CONTEXT_BYTES} bytes). ` +
        `Some referenced entities were omitted.`
    );
  }

  if (sections.length === 0) {
    return '';
  }

  return `## Referenced Entities\n\n${sections.join('\n')}`;
}

export function prependContextToMessage(userMessage: string, context: string): string {
  if (!context) {
    return userMessage;
  }
  return `${context}\n\n---\n\n${userMessage}`;
}

function formatReference(ref: ResolvedReference): string {
  switch (ref.type) {
    case 'file':
      return formatFile(
        ref.data as {
          path: string;
          content: string | null;
          binary: boolean;
          truncated: boolean;
        }
      );
    case 'folder':
      return formatFolder(
        ref.data as {
          path: string;
          entries: Array<{ name: string; type: 'file' | 'directory' }>;
        }
      );
    default:
      return '';
  }
}

function formatFile(data: {
  path: string;
  content: string | null;
  binary: boolean;
  truncated: boolean;
}): string {
  const lines: string[] = [`### File: ${data.path}`];
  if (data.binary) {
    lines.push('*[binary file — content not shown]*');
  } else if (data.content !== null) {
    const note = data.truncated ? ' (truncated)' : '';
    lines.push(`\`\`\`${note}`);
    lines.push(data.content);
    lines.push('```');
  } else {
    lines.push('*[content unavailable]*');
  }
  return lines.join('\n') + '\n';
}

function formatFolder(data: {
  path: string;
  entries: Array<{ name: string; type: 'file' | 'directory' }>;
}): string {
  const lines: string[] = [`### Folder: ${data.path}`];
  if (data.entries.length === 0) {
    lines.push('*[empty folder]*');
  } else {
    for (const entry of data.entries) {
      const suffix = entry.type === 'directory' ? '/' : '';
      lines.push(`- ${entry.name}${suffix}`);
    }
  }
  return lines.join('\n') + '\n';
}
