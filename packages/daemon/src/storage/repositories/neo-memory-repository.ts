import { Logger } from '../../lib/logger.ts';
import type { DbGateway } from '../db-gateway/db-gateway.ts';
import { embedQueryOrNull } from '../vector-similarity.ts';
import type { AgentMemoryEmbedder } from './agent-memory-repository.ts';
import { type NeoMemory, neoMemoryReads, neoMemoryWrites } from './neo-memory-worker.ts';

export type { NeoMemory } from './neo-memory-worker.ts';

const RRF_K = 60;
const log = new Logger('neo-memory-repository');

export class NeoMemoryRepository {
  constructor(
    private readonly gateway: DbGateway,
    private readonly embedder: () => AgentMemoryEmbedder | undefined = () => undefined
  ) {}

  async save(input: { key: string; content: string; sessionId?: string }) {
    const memory = await this.gateway.call(neoMemoryWrites, 'save', input);
    this.startFill();
    return memory;
  }

  read(key: string) {
    return this.gateway.call(neoMemoryReads, 'read', key);
  }

  delete(key: string) {
    return this.gateway.call(neoMemoryWrites, 'delete', key);
  }

  async search(query: string, limit: number): Promise<NeoMemory[]> {
    const fts = await this.gateway.call(neoMemoryReads, 'search', query, limit);
    const vector = await this.searchVector(query, limit);
    const scores = new Map<string, { memory: NeoMemory; score: number }>();
    for (const hits of [fts, vector])
      hits.forEach((memory, index) => {
        const entry = scores.get(memory.key) ?? { memory, score: 0 };
        entry.score += 1 / (RRF_K + index + 1);
        scores.set(memory.key, entry);
      });
    return [...scores.values()]
      .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  private async searchVector(query: string, limit: number): Promise<NeoMemory[]> {
    const embedder = this.embedder();
    if (!embedder) return [];
    const queryVector = await embedQueryOrNull(embedder, query);
    if (!queryVector) return [];
    this.startFill();
    return this.gateway.call(neoMemoryReads, 'searchVector', queryVector, embedder.model, limit);
  }

  private startFill(): void {
    this.fillVectors().catch((error) => log.error('Neo memory vector fill failed:', error));
  }

  private async fillVectors(): Promise<void> {
    const embedder = this.embedder();
    if (!embedder) return;
    for (let afterId = 0; ; ) {
      const rows = await this.gateway.call(neoMemoryReads, 'unembedded', embedder.model, afterId);
      if (rows.length === 0) return;
      for (const row of rows) {
        afterId = row.id;
        const passage = await embedQueryOrNull(
          { embedQuery: (text) => embedder.embedPassage(text) },
          row.text
        );
        if (passage)
          await this.gateway.call(
            neoMemoryWrites,
            'storeVector',
            row.id,
            row.content,
            embedder.model,
            passage
          );
      }
    }
  }
}
