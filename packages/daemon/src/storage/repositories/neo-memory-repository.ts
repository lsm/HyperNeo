import type { DbGateway } from '../db-gateway/db-gateway.ts';
import { embedQueryOrNull } from '../vector-similarity.ts';
import type { AgentMemoryEmbedder } from './agent-memory-repository.ts';
import { type NeoMemory, neoMemoryReads, neoMemoryWrites } from './neo-memory-worker.ts';

export type { NeoMemory } from './neo-memory-worker.ts';

const RRF_K = 60;

export class NeoMemoryRepository {
  constructor(
    private readonly gateway: DbGateway,
    private readonly embedder?: AgentMemoryEmbedder
  ) {}

  save(input: { key: string; content: string; sessionId?: string }) {
    return this.gateway.call(neoMemoryWrites, 'save', input);
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
    const embedder = this.embedder;
    if (!embedder) return [];
    const queryVector = await embedQueryOrNull(embedder, query);
    if (!queryVector) return [];
    for (const row of await this.gateway.call(neoMemoryReads, 'unembedded', embedder.model)) {
      const passage = await embedQueryOrNull(
        { embedQuery: (text) => embedder.embedPassage(text) },
        row.text
      );
      if (!passage) break;
      await this.gateway.call(
        neoMemoryWrites,
        'storeVector',
        row.id,
        row.content,
        embedder.model,
        passage
      );
    }
    return this.gateway.call(neoMemoryReads, 'searchVector', queryVector, embedder.model, limit);
  }
}
