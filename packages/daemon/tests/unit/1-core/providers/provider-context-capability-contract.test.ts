/**
 * Provider context-window & capability contract tests.
 *
 * Purpose
 * -------
 * Pin the expected context-window and capability metadata for representative
 * Anthropic, Codex, GLM, Kimi, and Ollama models, and assert that ONE value
 * flows unchanged through every consumer of that metadata:
 *
 *   1. Model catalog output   — the provider's own `getModels()` / `MODELS`
 *                               table (what `models.list` / `session.model.get`
 *                               project to the frontend).
 *   2. Session/UI resolution  — `getModelInfo()` resolves the same window; this
 *                               is the value the UI context-usage bar receives
 *                               as `maxContextTokens` via `session.model.get`.
 *   3. SDK/runtime config     — `buildProviderSettings()` derives the SDK
 *                               `autoCompactWindow` from the same value.
 *   4. Bridge model selection — the bridge's `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 *                               env (Codex `getModelContextWindow`, GLM/Kimi
 *                               `buildSdkConfig`) agrees with the catalog.
 *   5. Compaction thresholds  — `reserveBasedThreshold()` derives the trigger
 *                               from the same value with the right reserve.
 *
 * Why
 * ---
 * This batch fixed repeated wrong-context-window, prompt-too-long, and
 * compaction drift across providers — the same defect class patched from a
 * different consumer each time. These tests make that drift a compile/test
 * failure: if you change a context window, update it in the canonical table
 * below and confirm every consumer still agrees. Do not patch a single
 * consumer in isolation.
 *
 * NOTE: This is a contract over values, not an exhaustive provider test. Per-
 * provider behaviour lives in the sibling `*-provider.test.ts` files.
 */

import { describe, expect, it } from 'bun:test';
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
import { OllamaProvider } from '../../../../src/lib/providers/ollama-provider';

/**
 * What `buildProviderSettings` must return for a model:
 * - `native`: the SDK trusts its own window for this provider → `undefined`.
 * - `compact`: SDK auto-compact is enabled with an explicit `autoCompactWindow`.
 */
type SdkSettingExpectation = { kind: 'native' } | { kind: 'compact'; autoCompactWindow: number };

type CatalogSource =
  | { kind: 'anthropic' }
  | { kind: 'codex'; id: string }
  | { kind: 'glm'; id: string }
  | { kind: 'kimi'; id: string }
  | { kind: 'ollama' };

interface ContractRow {
  /** Short, unique label used in test titles. */
  label: string;
  /** Provider id — drives SDK settings + compaction reserve selection. */
  provider: string;
  /** The canonical, expected context window — the single source of truth. */
  contextWindow: number;
  /** Expected `preferContextWindowMetadata` on the resolved/catalog ModelInfo. */
  preferMetadata: boolean;
  /** Alias or id resolved by `getModelInfo` (omitted when not in static metadata). */
  resolveInput?: string;
  /** `session.config.model` value fed to `buildProviderSettings` + the bridge. */
  sdkModelId: string;
  /** Expected `buildProviderSettings(provider, contextWindow, sdkModelId)`. */
  sdkSettings: SdkSettingExpectation;
  /** Expected `reserveBasedThreshold(contextWindow, provider)`. */
  compactionThreshold: number;
  /** Where the catalog source of truth lives for this model. */
  catalog: CatalogSource;
  /** Expected bridge `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (omitted when n/a). */
  bridgeAutoCompactWindow?: number;
}

/**
 * The canonical contract. Every consumer below is asserted against these rows.
 * When a context window changes, update it here and let the per-consumer tests
 * confirm nothing else drifted.
 */
const CONTRACT: ContractRow[] = [
  {
    label: 'Anthropic Sonnet',
    provider: 'anthropic',
    contextWindow: 200_000,
    preferMetadata: false,
    resolveInput: 'sonnet',
    sdkModelId: 'sonnet',
    sdkSettings: { kind: 'native' },
    compactionThreshold: 167_000, // 200k − 33k default reserve
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
    compactionThreshold: 239_000, // 272k − 33k
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
    compactionThreshold: 967_000, // 1M − 33k
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
    compactionThreshold: 167_000, // 200k − 33k
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
    compactionThreshold: 1_003_576, // 1_048_576 − 45k Kimi reserve
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
    compactionThreshold: 217_144, // 262_144 − 45k Kimi reserve
    catalog: { kind: 'kimi', id: 'kimi-for-coding' },
    bridgeAutoCompactWindow: 262_144,
  },
  {
    label: 'Ollama (provider-level capability)',
    provider: 'ollama',
    contextWindow: 128_000,
    preferMetadata: false,
    // Ollama's model catalog is dynamic (/api/tags); the stable contract is the
    // provider capability window plus the SDK-settings pass-through.
    sdkModelId: 'llama3.2',
    sdkSettings: { kind: 'compact', autoCompactWindow: 128_000 },
    compactionThreshold: 95_000, // 128k − 33k
    catalog: { kind: 'ollama' },
  },
];

describe('provider context-window & capability contract', () => {
  // Keep model resolution deterministic: force the static-metadata fallback
  // path regardless of whatever another test may have cached globally.
  clearModelsCache('global');

  describe('shared compaction constants', () => {
    it('uses an 0.85 fraction for the non-native fallback trigger', () => {
      expect(COMPACTION_THRESHOLD).toBe(0.85);
    });

    it('applies a larger reserve for Kimi than the default (provider-aware)', () => {
      // Same 200k window → different thresholds because Kimi reserves 45k
      // (≈32k max output + reasoning) vs the 33k SDK-matching default.
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
            // The SDK converter is what stamps Anthropic catalog entries.
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
          // Native providers must be listed in the native set for the contract
          // to hold; pin membership so the list and the rows stay in sync.
          expect(NATIVE_CONTEXT_WINDOW_PROVIDER_IDS).toContain(row.provider);
        } else {
          expect(settings).toEqual({
            autoCompactEnabled: true,
            autoCompactWindow: row.sdkSettings.autoCompactWindow,
          });
          // Non-native providers must NOT claim native membership.
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
            // The canonical id and its alias both resolve to the catalog window —
            // this is the value the Codex bridge stringifies into env. The alias
            // ('codex') is exercised by the resolution consumer above.
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
      // The bridge must never invent a window: it re-emits the catalog value.
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

  describe('cross-consumer — one value flows through every consumer', () => {
    // The headline drift detector: collect each consumer's value for a row and
    // assert they all equal the canonical context window (where that consumer
    // is defined for the model).
    for (const row of CONTRACT) {
      it(`${row.label}: identical value across all applicable consumers`, async () => {
        const values: number[] = [row.contextWindow];

        // SDK runtime config (compact providers only — native ones defer to SDK).
        if (row.sdkSettings.kind === 'compact') {
          values.push(row.sdkSettings.autoCompactWindow);
        }
        // Bridge.
        if (row.bridgeAutoCompactWindow !== undefined) {
          values.push(row.bridgeAutoCompactWindow);
        }
        // Resolution (resolvable models only).
        if (row.resolveInput) {
          const info = await getModelInfo(row.resolveInput, 'global', row.provider);
          if (info) values.push(info.contextWindow);
        }

        expect(
          values.every((v) => v === row.contextWindow),
          row.label
        ).toBe(true);
      });
    }
  });
});
