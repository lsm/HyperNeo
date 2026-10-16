import { describe, expect, test } from 'bun:test';
import type { SettingSource, SpaceLongHorizonAgent, ThinkingLevel } from '@hyperneo/shared';
import {
  isRunnableUnifiedAgent,
  type WorkerAgentRowSource,
} from '../../../../src/lib/agents/worker-long-horizon-mapper.ts';

interface WorkerSeed {
  id: string;
  spaceId: string;
  name: string;
  handle: string | null;
  status: string;
  description: string;
  model: string | null;
  thinkingLevel: string | null;
  provider: string | null;
  customPrompt: string | null;
  systemPrompt: string;
  instructions: string | null;
  tools: string;
  settingSources: string | null;
  createdAt: number;
}

function rowSource(
  seed: Partial<WorkerSeed> & { id: string; spaceId: string }
): WorkerAgentRowSource {
  const full: WorkerSeed = {
    name: seed.name ?? seed.id,
    handle: seed.handle ?? null,
    status: seed.status ?? 'active',
    description: seed.description ?? '',
    model: seed.model ?? null,
    thinkingLevel: seed.thinkingLevel ?? null,
    provider: seed.provider ?? null,
    customPrompt: seed.customPrompt ?? null,
    systemPrompt: seed.systemPrompt ?? '',
    instructions: seed.instructions ?? null,
    tools: seed.tools ?? '[]',
    settingSources: seed.settingSources ?? null,
    createdAt: seed.createdAt ?? 100,
    ...seed,
  } as WorkerSeed;
  const tools =
    full.tools === '' || full.tools === '[]' ? [] : (JSON.parse(full.tools) as string[]);
  return {
    id: full.id,
    spaceId: full.spaceId,
    name: full.name,
    handle: full.handle,
    status: full.status,
    description: full.description,
    model: full.model,
    thinkingLevel: full.thinkingLevel as ThinkingLevel | null,
    provider: full.provider,
    customPrompt: full.customPrompt,
    instructions: full.instructions,
    systemPrompt: full.systemPrompt,
    tools,
    settingSources: full.settingSources
      ? (JSON.parse(full.settingSources) as SettingSource[])
      : null,
    createdAt: full.createdAt,
  };
}

function longHorizonAgent(overrides: Partial<SpaceLongHorizonAgent> = {}): SpaceLongHorizonAgent {
  return {
    id: 'lh-1',
    spaceId: 'space-a',
    handle: 'researcher',
    displayName: 'Researcher',
    templateKey: 'migration.legacy_space_agent',
    status: 'active',
    sessionId: null,
    instructions: 'Investigate thoroughly',
    autonomyLevel: null,
    model: 'kimi-for-coding',
    thinkingLevel: null,
    provider: 'kimi',
    settingSources: null,
    toolPermissions: { tools: ['Bash', 'Read'] },
    description: 'Does research',
    modelPool: [{ model: 'kimi-for-coding', maxConcurrent: 2, weight: 1 }],
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

describe('isRunnableUnifiedAgent — activity contract (U3a)', () => {
  test('migrated worker mirrors stay runnable in every status', () => {
    for (const status of ['active', 'paused', 'disabled', 'archived'] as const) {
      expect(
        isRunnableUnifiedAgent(
          longHorizonAgent({ templateKey: 'migration.legacy_space_agent', status })
        )
      ).toBe(true);
    }
  });

  test('genuine long-horizon rows are runnable only while active', () => {
    expect(isRunnableUnifiedAgent(longHorizonAgent({ templateKey: null }))).toBe(true);
    expect(isRunnableUnifiedAgent(longHorizonAgent({ templateKey: 'coordinator.default' }))).toBe(
      true
    );
    expect(isRunnableUnifiedAgent(longHorizonAgent({ templateKey: null, status: 'paused' }))).toBe(
      false
    );
    expect(
      isRunnableUnifiedAgent(longHorizonAgent({ templateKey: null, status: 'disabled' }))
    ).toBe(false);
    expect(
      isRunnableUnifiedAgent(longHorizonAgent({ templateKey: null, status: 'archived' }))
    ).toBe(false);
  });
});
