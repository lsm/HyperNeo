import { afterEach, expect, test } from 'bun:test';
import type { Query, SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, Session } from '@hyperneo/shared';
import { ContextFetcher } from '../../../../src/lib/agent/context-fetcher';
import {
  getSessionContextModelInfo,
  getModelInfo,
  setModelsCache,
} from '../../../../src/lib/model-service';

const model = {
  id: 'fixture-selected',
  name: 'Fixture',
  provider: 'deepseek',
  contextWindow: 1_000_000,
  autoCompactPercent: 80,
  available: true,
} as ModelInfo;
afterEach(() => setModelsCache(new Map()));

test.each(['deepseek', 'anthropic'] as const)(
  'keeps a session override through %s response-model resolution without changing catalog or native thresholds',
  async (provider) => {
    const selected = { ...model, provider };
    const responseModel = { ...selected, id: 'fixture-response', autoCompactPercent: 90 };
    setModelsCache(new Map([['global', [selected, responseModel]]]));
    const session = {
      id: 'neo:fixture',
      config: { model: selected.id, provider },
      metadata: { neoAutoCompactPercent: 70 },
    } as Session;
    const metadata = await getSessionContextModelInfo(session);
    const response = {
      model: responseModel.id,
      totalTokens: 690_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 69,
      categories: [],
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      gridRows: [],
      apiUsage: null,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 900_000,
    } as SDKControlGetContextUsageResponse;
    const query = { getContextUsage: async () => response } as unknown as Query;
    const info = await new ContextFetcher(session.id).fetch(query, metadata);
    expect(info?.autoCompactPercent).toBe(70);
    expect(info?.autoCompactThreshold).toBe(700_000);
    expect((await getModelInfo(selected.id, 'global', provider))?.autoCompactPercent).toBe(80);
    expect(
      (await getSessionContextModelInfo({ ...session, id: 'ordinary' }))?.autoCompactPercent
    ).toBe(80);
  }
);
