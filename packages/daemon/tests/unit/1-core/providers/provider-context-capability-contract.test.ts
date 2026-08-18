import { beforeEach, describe, expect, it } from 'bun:test';
import {
  COMPACTION_THRESHOLD,
  reserveBasedThreshold,
} from '../../../../src/lib/agent/context-tracker';
import {
  buildProviderSettings,
  NATIVE_CONTEXT_WINDOW_PROVIDER_IDS,
} from '../../../../src/lib/agent/query-options-builder';
import { clearModelsCache, getModelInfo } from '../../../../src/lib/model-service';
import { AnthropicProvider } from '../../../../src/lib/providers/anthropic-provider';
import {
  getCodexBridgeModelInfos,
  getModelContextWindow,
  MODEL_CONTEXT_WINDOWS,
} from '../../../../src/lib/providers/codex-models';
import { GlmProvider } from '../../../../src/lib/providers/glm-provider';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider';
import { MinimaxProvider } from '../../../../src/lib/providers/minimax-provider';
import { OllamaProvider } from '../../../../src/lib/providers/ollama-provider';
import { OpenRouterProvider } from '../../../../src/lib/providers/openrouter-provider';

type SdkSettingExpectation = { kind: 'native' } | { kind: 'compact'; autoCompactWindow: number };

type CatalogSource =
  | { kind: 'anthropic' }
  | { kind: 'codex'; id: string }
  | { kind: 'glm'; id: string }
  | { kind: 'kimi'; id: string }
  | { kind: 'minimax'; id: string }
  | { kind: 'ollama' }
  | { kind: 'openrouter'; id: string };

interface ContractRow {
  label: string;
  provider: string;
  contextWindow: number;
  preferMetadata: boolean;
  resolveInput?: string;
  sdkModelId: string;
  sdkSettings: SdkSettingExpectation;
  compactionThreshold: number;
  catalog: CatalogSource;
  bridgeAutoCompactWindow?: number;
}

const CONTRACT: ContractRow[] = [
  {
    label: 'Anthropic Sonnet',
    provider: 'anthropic',
    contextWindow: 200_000,
    preferMetadata: false,
    resolveInput: 'sonnet',
    sdkModelId: 'sonnet',
    sdkSettings: { kind: 'native' },
    compactionThreshold: 167_000,
    catalog: { kind: 'anthropic' },
  },
  {
    label: 'Codex GPT-5.3 (codex alias)',
    provider: 'anthropic-codex',
    contextWindow: 272_000,
    preferMetadata: true,
    resolveInput: 'codex',
    sdkModelId: 'gpt-5.3-codex',
    sdkSettings: { kind: 'native' },
    compactionThreshold: 239_000,
    catalog: { kind: 'codex', id: 'gpt-5.3-codex' },
    bridgeAutoCompactWindow: 272_000,
  },
  {
    label: 'GLM-5.2 (1M)',
    provider: 'glm',
    contextWindow: 1_000_000,
    preferMetadata: true,
    resolveInput: 'glm-5.2',
    sdkModelId: 'glm-5.2',
    sdkSettings: { kind: 'native' },
    compactionThreshold: 967_000,
    catalog: { kind: 'glm', id: 'glm-5.2[1m]' },
    bridgeAutoCompactWindow: 1_000_000,
  },
  {
    label: 'GLM-5',
    provider: 'glm',
    contextWindow: 200_000,
    preferMetadata: true,
    resolveInput: 'glm',
    sdkModelId: 'glm-5',
    sdkSettings: { kind: 'native' },
    compactionThreshold: 167_000,
    catalog: { kind: 'glm', id: 'glm-5' },
    bridgeAutoCompactWindow: 200_000,
  },
  {
    label: 'Kimi K3 (1M)',
    provider: 'kimi',
    contextWindow: 1_048_576,
    preferMetadata: true,
    resolveInput: 'k3',
    sdkModelId: 'kimi-k3[1m]',
    sdkSettings: { kind: 'compact', autoCompactWindow: 1_048_576 },
    compactionThreshold: 1_003_576,
    catalog: { kind: 'kimi', id: 'kimi-k3[1m]' },
    bridgeAutoCompactWindow: 1_048_576,
  },
  {
    label: 'Kimi K2.7 (kimi alias)',
    provider: 'kimi',
    contextWindow: 262_144,
    preferMetadata: true,
    resolveInput: 'kimi',
    sdkModelId: 'kimi-for-coding',
    sdkSettings: { kind: 'compact', autoCompactWindow: 262_144 },
    compactionThreshold: 217_144,
    catalog: { kind: 'kimi', id: 'kimi-for-coding' },
    bridgeAutoCompactWindow: 262_144,
  },
  {
    label: 'Ollama (provider-level capability)',
    provider: 'ollama',
    contextWindow: 128_000,
    preferMetadata: false,
    sdkModelId: 'llama3.2',
    sdkSettings: { kind: 'compact', autoCompactWindow: 128_000 },
    compactionThreshold: 95_000,
    catalog: { kind: 'ollama' },
  },
  {
    label: 'MiniMax M2.5 (minimax alias)',
    provider: 'minimax',
    contextWindow: 200_000,
    preferMetadata: false,
    sdkModelId: 'MiniMax-M2.5',
    sdkSettings: { kind: 'compact', autoCompactWindow: 200_000 },
    compactionThreshold: 167_000,
    catalog: { kind: 'minimax', id: 'MiniMax-M2.5' },
  },
  {
    label: 'OpenRouter Auto (1M capability)',
    provider: 'openrouter',
    contextWindow: 1_000_000,
    preferMetadata: false,
    sdkModelId: 'openrouter/auto',
    sdkSettings: { kind: 'compact', autoCompactWindow: 1_000_000 },
    compactionThreshold: 967_000,
    catalog: { kind: 'openrouter', id: 'openrouter/auto' },
  },
];

describe('provider context-window & capability contract', () => {
  beforeEach(() => {
    clearModelsCache('global');
  });

  describe('shared compaction constants', () => {
    it('uses an 0.85 fraction for the non-native fallback trigger', () => {
      expect(COMPACTION_THRESHOLD).toBe(0.85);
    });

    it('applies a larger reserve for Kimi than the default (provider-aware)', () => {
      expect(reserveBasedThreshold(200_000, 'anthropic')).toBe(167_000);
      expect(reserveBasedThreshold(200_000, 'kimi')).toBe(155_000);
    });

    it('floors tiny/invalid windows at a non-positive threshold', () => {
      expect(reserveBasedThreshold(0, 'anthropic')).toBe(0);
      expect(reserveBasedThreshold(-5, 'kimi')).toBe(0);
      expect(reserveBasedThreshold(Number.NaN, 'glm')).toBe(0);
    });
  });

  describe('consumer 1 — model catalog output (source of truth)', () => {
    for (const row of CONTRACT) {
      it(`${row.label}: catalog reports contextWindow ${row.contextWindow.toLocaleString()}`, () => {
        const source = row.catalog;
        switch (source.kind) {
          case 'anthropic': {
            const provider = new AnthropicProvider();
            expect(provider.capabilities.maxContextWindow).toBe(row.contextWindow);
            const converted = provider.convertSdkModels([
              {
                value: 'sonnet',
                displayName: 'Claude Sonnet',
                description: 'Claude Sonnet 4.6 · x',
              },
            ]);
            expect(converted.find((m) => m.id === 'sonnet')?.contextWindow).toBe(row.contextWindow);
            break;
          }
          case 'codex': {
            expect(MODEL_CONTEXT_WINDOWS[source.id]).toBe(row.contextWindow);
            expect(getModelContextWindow(source.id)).toBe(row.contextWindow);
            const entry = getCodexBridgeModelInfos().find((m) => m.id === source.id);
            expect(entry?.contextWindow).toBe(row.contextWindow);
            expect(entry?.preferContextWindowMetadata).toBe(true);
            break;
          }
          case 'glm': {
            const entry = GlmProvider.MODELS.find((m) => m.id === source.id);
            expect(entry?.contextWindow).toBe(row.contextWindow);
            expect(entry?.preferContextWindowMetadata).toBe(true);
            break;
          }
          case 'kimi': {
            const entry = KimiProvider.MODELS.find((m) => m.id === source.id);
            expect(entry?.contextWindow).toBe(row.contextWindow);
            expect(entry?.preferContextWindowMetadata).toBe(true);
            break;
          }
          case 'ollama': {
            const provider = new OllamaProvider({ kind: 'local' });
            expect(provider.capabilities.maxContextWindow).toBe(row.contextWindow);
            break;
          }
          case 'minimax': {
            const entry = MinimaxProvider.MODELS.find((m) => m.id === source.id);
            expect(entry?.contextWindow).toBe(row.contextWindow);
            break;
          }
          case 'openrouter': {
            const entry = OpenRouterProvider.FALLBACK_MODELS.find((m) => m.id === source.id);
            expect(entry?.contextWindow).toBe(row.contextWindow);
            break;
          }
        }
      });
    }
  });

  describe('consumer 2 — session/UI model resolution (getModelInfo)', () => {
    for (const row of CONTRACT) {
      if (!row.resolveInput) continue;
      it(`${row.label}: resolves to contextWindow ${row.contextWindow.toLocaleString()}`, async () => {
        const info = await getModelInfo(row.resolveInput, 'global', row.provider);
        expect(info).not.toBeNull();
        expect(info?.contextWindow).toBe(row.contextWindow);
        expect(info?.preferContextWindowMetadata ?? false).toBe(row.preferMetadata);
      });
    }

    it('resolution agrees with the catalog source for every resolvable row', async () => {
      for (const row of CONTRACT) {
        if (!row.resolveInput) continue;
        const info = await getModelInfo(row.resolveInput, 'global', row.provider);
        expect(info?.contextWindow, `${row.label} resolution`).toBe(row.contextWindow);
      }
    });
  });

  describe('consumer 3 — SDK/runtime config (buildProviderSettings)', () => {
    for (const row of CONTRACT) {
      it(`${row.label}: buildProviderSettings matches expectation`, () => {
        const settings = buildProviderSettings(row.provider, row.contextWindow, row.sdkModelId);
        if (row.sdkSettings.kind === 'native') {
          expect(settings).toBeUndefined();
          expect(NATIVE_CONTEXT_WINDOW_PROVIDER_IDS).toContain(row.provider);
        } else {
          expect(settings).toEqual({
            autoCompactEnabled: true,
            autoCompactWindow: row.sdkSettings.autoCompactWindow,
          });
          expect(NATIVE_CONTEXT_WINDOW_PROVIDER_IDS).not.toContain(row.provider);
        }
      });
    }
  });

  describe('consumer 4 — bridge model selection (auto-compact window)', () => {
    for (const row of CONTRACT) {
      if (row.bridgeAutoCompactWindow === undefined) continue;
      const expected = row.bridgeAutoCompactWindow;
      switch (row.catalog.kind) {
        case 'codex':
          it(`${row.label}: getModelContextWindow returns ${expected.toLocaleString()}`, () => {
            expect(getModelContextWindow(row.sdkModelId)).toBe(expected);
            expect(
              MODEL_CONTEXT_WINDOWS[row.sdkModelId as keyof typeof MODEL_CONTEXT_WINDOWS]
            ).toBe(expected);
          });
          break;
        case 'glm':
          it(`${row.label}: buildSdkConfig sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=${expected}`, () => {
            const cfg = new GlmProvider({}).buildSdkConfig(row.sdkModelId, { apiKey: 'test-key' });
            expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(expected));
          });
          break;
        case 'kimi':
          it(`${row.label}: buildSdkConfig sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=${expected}`, () => {
            const cfg = new KimiProvider({}).buildSdkConfig(row.sdkModelId, { apiKey: 'test-key' });
            expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(expected));
          });
          break;
        default:
          break;
      }
    }

    it('every bridge auto-compact window equals the canonical context window', () => {
      for (const row of CONTRACT) {
        if (row.bridgeAutoCompactWindow === undefined) continue;
        expect(row.bridgeAutoCompactWindow, row.label).toBe(row.contextWindow);
      }
    });
  });

  describe('consumer 5 — compaction thresholds (reserveBasedThreshold)', () => {
    for (const row of CONTRACT) {
      it(`${row.label}: threshold is ${row.compactionThreshold.toLocaleString()}`, () => {
        expect(reserveBasedThreshold(row.contextWindow, row.provider)).toBe(
          row.compactionThreshold
        );
      });
    }

    it('thresholds always stay strictly below their context window', () => {
      for (const row of CONTRACT) {
        expect(reserveBasedThreshold(row.contextWindow, row.provider), row.label).toBeLessThan(
          row.contextWindow
        );
      }
    });
  });
});
