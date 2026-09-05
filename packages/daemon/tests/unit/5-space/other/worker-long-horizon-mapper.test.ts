import { describe, expect, test } from 'bun:test';
import type { SettingSource, SpaceLongHorizonAgent, ThinkingLevel } from '@hyperneo/shared';
import {
  isRunnableUnifiedAgent,
  type WorkerAgentRowSource,
  workerAgentToLongHorizonParams,
} from '../../../../src/lib/space/agents/worker-long-horizon-mapper.ts';

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

describe('workerAgentToLongHorizonParams — typed extensions beyond m155', () => {
  const NOW = 12345;

  test('instructions term sits between custom_prompt and system_prompt in the fallback chain', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({
        id: 'w-1',
        spaceId: 'space-a',
        instructions: 'Inline prompt',
        systemPrompt: 'Sys',
      }),
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.instructions).toBe('Inline prompt');
  });

  test('empty-string custom_prompt wins over later terms, matching SQL COALESCE', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({
        id: 'w-1',
        spaceId: 'space-a',
        customPrompt: '',
        instructions: 'Inline prompt',
        systemPrompt: 'Sys',
      }),
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.instructions).toBe('');
  });

  test('carries description and modelPool for the unified table (D-DM-2/D-DM-3)', () => {
    const withPool = workerAgentToLongHorizonParams(
      {
        ...rowSource({ id: 'w-1', spaceId: 'space-a', description: 'Runs things' }),
        modelPool: [{ model: 'm1', provider: 'provider-x', maxConcurrent: 2, weight: 1 }],
      },
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(withPool.description).toBe('Runs things');
    expect(withPool.modelPool).toEqual([
      { model: 'm1', provider: 'provider-x', maxConcurrent: 2, weight: 1 },
    ]);

    const withoutExtras = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-2', spaceId: 'space-a' }),
      {
        occupiedHandles: new Set<string>(),
        now: NOW,
      }
    );

    expect(withoutExtras.description).toBeUndefined();
    expect(withoutExtras.modelPool).toBeUndefined();
  });

  test('missing createdAt falls back to the caller-provided now stamp', () => {
    const params = workerAgentToLongHorizonParams(
      { ...rowSource({ id: 'w-1', spaceId: 'space-a' }), createdAt: null },
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.createdAt).toBe(NOW);
    expect(params.updatedAt).toBe(NOW);
  });

  test('noncanonical statuses normalize to active like the SQL CASE ELSE', () => {
    for (const status of ['', 'unknown'] as const) {
      const params = workerAgentToLongHorizonParams(
        { ...rowSource({ id: 'w-1', spaceId: 'space-a' }), status },
        { occupiedHandles: new Set<string>(), now: NOW }
      );

      expect(params.status).toBe('active');
    }
  });

  test('collision suffix appends the agent id to the base handle (D-DM-4)', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-1', spaceId: 'space-a', handle: 'researcher', name: 'Researcher' }),
      {
        occupiedHandles: new Set<string>(['researcher']),
        now: NOW,
      }
    );

    expect(params.handle).toBe('researcher-w-1');
    expect(params.displayName).toBe('Researcher');
  });

  test('re-suffixed handles stay clear when both the base and first suffix are occupied', () => {
    const params = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-1', spaceId: 'space-a', handle: 'researcher', name: 'Researcher' }),
      { occupiedHandles: new Set<string>(['researcher', 'researcher-w-1']), now: NOW }
    );

    expect(params.handle).toBe('researcher-w-1-2');
  });

  test('uuid-length ids trim the stem so the counter survives the 60-char bound', () => {
    const uuid = '5fb7c7e2-91a3-4d64-9f0e-1a2b3c4d5e6f';
    const base = 'abcdefghijklmnopqrstuvw';
    const first = `${base}-${uuid}`;
    const second = `${base.slice(0, 21)}-${uuid}-2`;
    const params = workerAgentToLongHorizonParams(
      rowSource({ id: uuid, spaceId: 'space-a', handle: base, name: 'Base' }),
      { occupiedHandles: new Set<string>([base, first]), now: NOW }
    );

    expect(params.handle.length).toBeLessThanOrEqual(60);
    expect(params.handle).toBe(second);
    expect(params.handle).not.toBe(first);
  });

  test('batch callers reserve each chosen handle so converted rows cannot collide', () => {
    const reserved = new Set<string>(['researcher']);
    const first = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-1', spaceId: 'space-a', handle: 'researcher' }),
      {
        occupiedHandles: reserved,
        now: NOW,
      }
    );
    reserved.add(first.handle);
    const second = workerAgentToLongHorizonParams(
      rowSource({ id: 'w-2', spaceId: 'space-a', handle: 'researcher' }),
      { occupiedHandles: reserved, now: NOW }
    );
    reserved.add(second.handle);

    expect(first.handle).toBe('researcher-w-1');
    expect(second.handle).toBe('researcher-w-2');
  });

  test('name and id fill the handle and displayName fallbacks in COALESCE order', () => {
    const params = workerAgentToLongHorizonParams(
      { ...rowSource({ id: 'w-9', spaceId: 'space-a', name: 'Named' }), handle: null },
      { occupiedHandles: new Set<string>(), now: NOW }
    );

    expect(params.handle).toBe('Named');
    expect(params.displayName).toBe('Named');
  });
});

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
