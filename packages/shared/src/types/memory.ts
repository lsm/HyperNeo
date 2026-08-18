export interface AgentMemoryEntry {
  key: string;
  spaceId: string;
  content: string;
  tags: string[];
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number | null;
}

export interface AgentMemorySearchResult {
  memory: AgentMemoryEntry;
  rank: number;
}
