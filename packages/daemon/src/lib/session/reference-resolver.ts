import type { ReferenceMention, ReferenceMetadata, ResolvedReference } from '@hyperneo/shared';
import { REFERENCE_PATTERN } from '@hyperneo/shared';
import type {
  TaskRepoForReference,
  GoalRepoForReference,
} from '../rpc-handlers/reference-handlers';
import { resolveFile, resolveFolder } from '../rpc-handlers/reference-handlers';
import { Logger } from '../logger';

const log = new Logger('ReferenceResolver');

export interface ResolutionContext {
  workspacePath: string | null;
  roomId: string | null;
}

export interface PreprocessedMessage {
  text: string;
  referenceMetadata: ReferenceMetadata;
  resolvedReferences: Record<string, ResolvedReference>;
}

export interface ReferenceResolverDeps {
  taskRepo: TaskRepoForReference;
  goalRepo: GoalRepoForReference;
}

export class ReferenceResolver {
  constructor(private deps: ReferenceResolverDeps) {}

  static extractReferences(text: string): ReferenceMention[] {
    REFERENCE_PATTERN.lastIndex = 0;
    const mentions: ReferenceMention[] = [];
    let match: RegExpExecArray | null;

    while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
      const type = match[1] as ReferenceMention['type'];
      const id = match[2];

      if (type !== 'task' && type !== 'goal' && type !== 'file' && type !== 'folder') {
        continue;
      }

      mentions.push({ type, id, displayText: id });
    }

    return mentions;
  }

  async resolveReference(
    mention: ReferenceMention,
    context: ResolutionContext
  ): Promise<ResolvedReference | null> {
    try {
      switch (mention.type) {
        case 'task':
          return this.resolveTask(mention.id, context.roomId);

        case 'goal':
          return this.resolveGoal(mention.id, context.roomId);

        case 'file':
          if (!context.workspacePath) return null;
          return resolveFile(mention.id, context.workspacePath);

        case 'folder':
          if (!context.workspacePath) return null;
          return resolveFolder(mention.id, context.workspacePath);

        default: {
          log.warn(`Unknown reference type: ${mention.type as string}`);
          return null;
        }
      }
    } catch (err) {
      log.warn(`Failed to resolve reference ${mention.type}:${mention.id}:`, err);
      return null;
    }
  }

  async resolveAllReferences(
    mentions: ReferenceMention[],
    context: ResolutionContext
  ): Promise<Record<string, ResolvedReference>> {
    const seen = new Map<string, ReferenceMention>();
    for (const mention of mentions) {
      const token = `@ref{${mention.type}:${mention.id}}`;
      if (!seen.has(token)) {
        seen.set(token, mention);
      }
    }

    const uniqueTokens = Array.from(seen.keys());
    const uniqueMentions = Array.from(seen.values());

    const results = await Promise.all(
      uniqueMentions.map((mention) => this.resolveReference(mention, context))
    );

    const metadata: Record<string, ResolvedReference> = {};
    for (let i = 0; i < results.length; i++) {
      const resolved = results[i];
      if (resolved !== null) {
        metadata[uniqueTokens[i]] = resolved;
      }
    }

    return metadata;
  }

  private resolveTask(id: string, roomId: string | null): ResolvedReference | null {
    let task = this.deps.taskRepo.getTask(id);
    if (!task && roomId) {
      task = this.deps.taskRepo.getTaskByShortId(roomId, id);
    }

    if (!task) {
      return null;
    }

    if (roomId && (task as { roomId?: string }).roomId !== roomId) {
      return null;
    }

    return { type: 'task', id, data: task };
  }

  private resolveGoal(id: string, roomId: string | null): ResolvedReference | null {
    let goal = this.deps.goalRepo.getGoal(id);
    if (!goal && roomId) {
      goal = this.deps.goalRepo.getGoalByShortId(roomId, id);
    }

    if (!goal) {
      return null;
    }

    if (roomId && (goal as { roomId?: string }).roomId !== roomId) {
      return null;
    }

    return { type: 'goal', id, data: goal };
  }
}
