import type { DbGateway } from '../db-gateway/db-gateway.ts';
import { neoMemoryReads, neoMemoryWrites } from './neo-memory-worker.ts';

export type { NeoMemory } from './neo-memory-worker.ts';

export class NeoMemoryRepository {
  constructor(private readonly gateway: DbGateway) {}

  save(input: { key: string; content: string; sessionId?: string }) {
    return this.gateway.call(neoMemoryWrites, 'save', input);
  }

  read(key: string) {
    return this.gateway.call(neoMemoryReads, 'read', key);
  }

  delete(key: string) {
    return this.gateway.call(neoMemoryWrites, 'delete', key);
  }

  search(query: string, limit: number) {
    return this.gateway.call(neoMemoryReads, 'search', query, limit);
  }
}
