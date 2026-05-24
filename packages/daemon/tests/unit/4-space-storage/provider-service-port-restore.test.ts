/**
 * ProviderService.restoreEnvVars PORT / NEOKAI_PORT restoration tests
 *
 * Tests that restoreEnvVars correctly handles the PORT and NEOKAI_PORT keys in
 * OriginalEnvVars as part of the fix that clears both before SDK query to prevent
 * the kill-chain bug (daemon port leaked → lsof → kill parent process).
 *
 * Covers:
 * - OriginalEnvVars interface includes PORT and NEOKAI_PORT fields
 * - restoreEnvVars restores both when the original values were defined
 * - restoreEnvVars deletes both when the original value was undefined (never set)
 * - restoreEnvVars does nothing when the key is absent from the original object
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { OriginalEnvVars } from '../../../src/lib/agent/query-runner';
import { ProviderService } from '../../../src/lib/provider-service';

// Capture the original values so tests can restore after themselves
const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_NEOKAI_PORT = process.env.NEOKAI_PORT;

describe('OriginalEnvVars interface — PORT and NEOKAI_PORT fields', () => {
  it('accepts PORT as an optional string field', () => {
    const vars: OriginalEnvVars = { PORT: '9283' };
    expect(vars.PORT).toBe('9283');
  });

  it('accepts PORT as undefined', () => {
    const vars: OriginalEnvVars = { PORT: undefined };
    expect(vars.PORT).toBeUndefined();
  });

  it('accepts NEOKAI_PORT as an optional string field', () => {
    const vars: OriginalEnvVars = { NEOKAI_PORT: '9983' };
    expect(vars.NEOKAI_PORT).toBe('9983');
  });

  it('accepts NEOKAI_PORT as undefined', () => {
    const vars: OriginalEnvVars = { NEOKAI_PORT: undefined };
    expect(vars.NEOKAI_PORT).toBeUndefined();
  });

  it('accepts an object with no PORT or NEOKAI_PORT key', () => {
    const vars: OriginalEnvVars = {};
    expect(Object.prototype.hasOwnProperty.call(vars, 'PORT')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(vars, 'NEOKAI_PORT')).toBe(false);
  });
});

describe('ProviderService.restoreEnvVars — PORT restoration', () => {
  let service: ProviderService;

  beforeEach(() => {
    service = new ProviderService();
  });

  afterEach(() => {
    if (ORIGINAL_PORT !== undefined) {
      process.env.PORT = ORIGINAL_PORT;
    } else {
      delete process.env.PORT;
    }
  });

  it('restores PORT to the original value when original.PORT was defined', () => {
    process.env.PORT = 'mutated-during-query';

    const original: OriginalEnvVars = { PORT: '9283' };
    service.restoreEnvVars(original);

    expect(process.env.PORT).toBe('9283');
  });

  it('deletes PORT when original.PORT was explicitly undefined (port was not set before query)', () => {
    process.env.PORT = 'leaked-port';

    const original: OriginalEnvVars = { PORT: undefined };
    service.restoreEnvVars(original);

    expect(process.env.PORT).toBeUndefined();
  });

  it('does NOT touch PORT when the PORT key is absent from the original object', () => {
    process.env.PORT = 'should-be-untouched';

    const original: OriginalEnvVars = {};
    service.restoreEnvVars(original);

    expect(process.env.PORT).toBe('should-be-untouched');
  });

  it('handles an empty original object without throwing', () => {
    const original: OriginalEnvVars = {};
    expect(() => service.restoreEnvVars(original)).not.toThrow();
  });

  it('restores PORT alongside other keys in the same call', () => {
    process.env.PORT = 'wrong';
    process.env.ANTHROPIC_BASE_URL = 'http://proxy.example.com';

    const original: OriginalEnvVars = {
      PORT: '8080',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    };
    service.restoreEnvVars(original);

    expect(process.env.PORT).toBe('8080');
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');

    delete process.env.ANTHROPIC_BASE_URL;
  });
});

describe('ProviderService.restoreEnvVars — NEOKAI_PORT restoration', () => {
  let service: ProviderService;

  beforeEach(() => {
    service = new ProviderService();
  });

  afterEach(() => {
    if (ORIGINAL_NEOKAI_PORT !== undefined) {
      process.env.NEOKAI_PORT = ORIGINAL_NEOKAI_PORT;
    } else {
      delete process.env.NEOKAI_PORT;
    }
  });

  it('restores NEOKAI_PORT to the original value when original.NEOKAI_PORT was defined', () => {
    process.env.NEOKAI_PORT = 'mutated-during-query';

    const original: OriginalEnvVars = { NEOKAI_PORT: '9983' };
    service.restoreEnvVars(original);

    expect(process.env.NEOKAI_PORT).toBe('9983');
  });

  it('deletes NEOKAI_PORT when original.NEOKAI_PORT was explicitly undefined', () => {
    process.env.NEOKAI_PORT = 'leaked-neokai-port';

    const original: OriginalEnvVars = { NEOKAI_PORT: undefined };
    service.restoreEnvVars(original);

    expect(process.env.NEOKAI_PORT).toBeUndefined();
  });

  it('does NOT touch NEOKAI_PORT when the key is absent from the original object', () => {
    process.env.NEOKAI_PORT = 'should-be-untouched';

    const original: OriginalEnvVars = {};
    service.restoreEnvVars(original);

    expect(process.env.NEOKAI_PORT).toBe('should-be-untouched');
  });

  it('restores both PORT and NEOKAI_PORT together in one restoreEnvVars call', () => {
    process.env.PORT = 'wrong-port';
    process.env.NEOKAI_PORT = 'wrong-neokai-port';

    const original: OriginalEnvVars = { PORT: '8399', NEOKAI_PORT: '9983' };
    service.restoreEnvVars(original);

    expect(process.env.PORT).toBe('8399');
    expect(process.env.NEOKAI_PORT).toBe('9983');
  });
});
