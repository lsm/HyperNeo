import type { ResolvedReference } from '@hyperneo/shared';
import type { MissionMetric, NeoTask, RoomGoal } from '@hyperneo/shared/types/neo';
import { Logger } from '../logger.ts';

const log = new Logger('reference-context-builder');

export const MAX_CONTEXT_BYTES = 200_000;

const PRIORITY_ORDER: ReadonlyArray<ResolvedReference['type']> = ['task', 'goal', 'file', 'folder'];

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
    case 'task':
      return formatTask(ref.data as NeoTask, ref.id);
    case 'goal':
      return formatGoal(ref.data as RoomGoal, ref.id);
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

function formatTask(task: NeoTask, fallbackId: string): string {
  const id = task.shortId ?? fallbackId;
  const lines: string[] = [`### Task: ${id}`];
  lines.push(`**Title:** ${task.title}`);
  lines.push(`**Status:** ${task.status}`);
  lines.push(`**Priority:** ${task.priority}`);
  if (task.progress !== null && task.progress !== undefined) {
    lines.push(`**Progress:** ${task.progress}%`);
  }
  if (task.description) {
    lines.push(`**Description:** ${task.description}`);
  }
  if (task.currentStep) {
    lines.push(`**Current Step:** ${task.currentStep}`);
  }
  return lines.join('\n') + '\n';
}

function formatGoal(goal: RoomGoal, fallbackId: string): string {
  const id = goal.shortId ?? fallbackId;
  const lines: string[] = [`### Goal: ${id}`];
  lines.push(`**Title:** ${goal.title}`);
  if (goal.missionType) {
    lines.push(`**Type:** ${goal.missionType}`);
  }
  lines.push(`**Status:** ${goal.status}`);
  lines.push(`**Progress:** ${goal.progress}%`);
  if (goal.description) {
    lines.push(`**Description:** ${goal.description}`);
  }
  if (goal.structuredMetrics && goal.structuredMetrics.length > 0) {
    const metricsStr = goal.structuredMetrics.map(formatMetric).join(', ');
    lines.push(`**Metrics:** ${metricsStr}`);
  }
  return lines.join('\n') + '\n';
}

function formatMetric(m: MissionMetric): string {
  const current = m.unit ? `${m.current} ${m.unit}` : String(m.current);
  const target = m.unit ? `${m.target} ${m.unit}` : String(m.target);
  return `${m.name}: ${current} / ${target}`;
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
