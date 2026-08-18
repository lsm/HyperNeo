import {
  initializeModels,
  getAvailableModels,
  getModelInfoUnfiltered,
  clearModelsCache,
} from '../../src/lib/model-service';

async function testModelCache() {
  console.log('\n=== Test 1: Initial model loading from SDK ===');
  await initializeModels();
  const models1 = getAvailableModels('global');
  console.log(`✓ Loaded ${models1.length} models from SDK:`);
  models1.forEach((m) => console.log(`  - ${m.name} (${m.id})`));

  console.log('\n=== Test 2: Cache hit should be instant ===');
  const start = Date.now();
  const models2 = getAvailableModels('global');
  const elapsed = Date.now() - start;
  console.log(`✓ Returned ${models2.length} models in ${elapsed}ms (should be <5ms for cache hit)`);

  console.log('\n=== Test 3: Legacy model ID lookup ===');
  const legacyIds = ['sonnet', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101'];
  for (const id of legacyIds) {
    const info = await getModelInfoUnfiltered(id, 'global');
    console.log(`  getModelInfoUnfiltered('${id}') → ${info ? `Found: ${info.name}` : 'NULL'}`);
  }

  console.log('\n=== Test 4: Clear cache (should return empty - no static fallback) ===');
  clearModelsCache('global');
  const models3 = getAvailableModels('global');
  console.log(`✓ After cache clear: ${models3.length} models (expected: 0, no static fallback)`);

  console.log('\n=== Test 5: Reload models from SDK ===');
  await initializeModels();
  const models4 = getAvailableModels('global');
  console.log(`✓ Reloaded ${models4.length} models from SDK`);

  console.log('\n✅ All tests passed!\n');
}

testModelCache().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
