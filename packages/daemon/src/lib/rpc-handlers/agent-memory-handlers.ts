import type { MessageHub } from '@neokai/shared';
import type { AgentMemoryRepository } from '../../storage/repositories/agent-memory-repository';

export interface AgentMemoryHandlerDeps {
  memoryRepo: AgentMemoryRepository;
}

export function setupAgentMemoryHandlers(
  messageHub: MessageHub,
  deps: AgentMemoryHandlerDeps
): void {
  messageHub.onRequest('agentMemory.write', async (payload: unknown) => {
    const request = parseSpaceScopedRequest(payload);
    return deps.memoryRepo.write({
      spaceId: request.spaceId,
      key: readRequiredString(payload, 'key'),
      content: readRequiredString(payload, 'content'),
      // Forward `tags` only when the caller actually sent it so the repository
      // can preserve previously stored tags on content-only updates instead of
      // silently clearing them.
      tags: readOptionalStringArray(payload, 'tags'),
      // Provenance is never trusted from RPC payloads — RPC writes have no
      // agent-session attribution. Agent-authored writes flow through the MCP
      // tool, which supplies the session id from the runtime.
      createdBySession: null,
    });
  });

  messageHub.onRequest('agentMemory.search', async (payload: unknown) => {
    const request = parseSpaceScopedRequest(payload);
    return deps.memoryRepo.search(
      request.spaceId,
      readRequiredString(payload, 'query'),
      readOptionalInteger(payload, 'limit') ?? 10
    );
  });

  messageHub.onRequest('agentMemory.read', async (payload: unknown) => {
    const request = parseSpaceScopedRequest(payload);
    return deps.memoryRepo.read(request.spaceId, readRequiredString(payload, 'key'));
  });

  messageHub.onRequest('agentMemory.delete', async (payload: unknown) => {
    const request = parseSpaceScopedRequest(payload);
    return { deleted: deps.memoryRepo.delete(request.spaceId, readRequiredString(payload, 'key')) };
  });

  messageHub.onRequest('agentMemory.list', async (payload: unknown) => {
    const request = parseSpaceScopedRequest(payload);
    return deps.memoryRepo.list(request.spaceId, {
      query: readOptionalString(payload, 'query') ?? undefined,
      limit: readOptionalInteger(payload, 'limit') ?? 50,
      offset: readOptionalInteger(payload, 'offset') ?? 0,
    });
  });
}

function parseSpaceScopedRequest(payload: unknown): { spaceId: string } {
  return { spaceId: readRequiredString(payload, 'spaceId') };
}

function readRequiredString(payload: unknown, key: string): string {
  const value = readRecord(payload)[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(payload: unknown, key: string): string | null {
  const value = readRecord(payload)[key];
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalStringArray(payload: unknown, key: string): string[] | undefined {
  const value = readRecord(payload)[key];
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

function readOptionalInteger(payload: unknown, key: string): number | undefined {
  const value = readRecord(payload)[key];
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  // SQLite stores integers as int64, but any value outside the JS safe-integer
  // range loses precision before reaching the driver and is rejected with a
  // datatype-mismatch error. Validate up-front so callers see a clean message.
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a safe integer.`);
  }
  return value;
}

function readRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request payload must be an object.');
  }
  return payload as Record<string, unknown>;
}
