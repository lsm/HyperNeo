import { describe, expect, test } from 'bun:test';
import { BUILT_IN_HOOKS } from '../src';
import { BUILT_IN_HOOK_IDS } from '@hyperneo/shared/types/workflow-hooks';

// The shared contract list (consumed by the web client and portable
// validators, which cannot import the extensions package) must stay in sync
// with the actual registry — a drift would make bindings reference hook ids
// that resolve nowhere, or mark resolvable ids as dangling.
describe('BUILT_IN_HOOK_IDS ↔ registry sync', () => {
  test('the shared list and the registry contain exactly the same ids', () => {
    const registryIds = [...new Set(BUILT_IN_HOOKS.map((hook) => hook.id))].sort();
    expect([...BUILT_IN_HOOK_IDS].sort()).toEqual(registryIds);
  });
});
