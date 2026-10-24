import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';

if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic test daemon only');
const models = [
  ['opus', 'claude-opus-5-5'],
  ['sonnet', 'claude-sonnet-5-5'],
  ['haiku', 'claude-haiku-5-5'],
  ['fable', 'claude-fable-5-1'],
].map(([value, resolvedModel]) => ({ value, resolvedModel, displayName: resolvedModel, description: 'Synthetic 1M catalog', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] as const }));
AnthropicProvider.prototype.listRemoteModels = async function () {
  const catalog = this.convertSdkModels(models.map((model) => ({ ...model, supportedEffortLevels: [...model.supportedEffortLevels] })));
  this.setModelCache(catalog);
  return catalog;
};
await import('../../../packages/cli/main.ts');
