import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { OriginalEnvVars } from '../../../src/lib/agent/query-runner';
import { ProviderService } from '../../../src/lib/provider-service';

const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_HYPERNEO_PORT = process.env.HYPERNEO_PORT;

describe('OriginalEnvVars interface — PORT and HYPERNEO_PORT fields', () => {
  it('accepts PORT as an optional string field', () => {
    const vars: OriginalEnvVars = { PORT: '9283' };
    expect(vars.PORT).toBe('9283');
  });

  it('accepts PORT as undefined', () => {
    const vars: OriginalEnvVars = { PORT: undefined };
    expect(vars.PORT).toBeUndefined();
  });

  it('accepts HYPERNEO_PORT as an optional string field', () => {
    const vars: OriginalEnvVars = { HYPERNEO_PORT: '9983' };
    expect(vars.HYPERNEO_PORT).toBe('9983');
  });

  it('accepts HYPERNEO_PORT as undefined', () => {
    const vars: OriginalEnvVars = { HYPERNEO_PORT: undefined };
    expect(vars.HYPERNEO_PORT).toBeUndefined();
  });

  it('accepts an object with no PORT or HYPERNEO_PORT key', () => {
    const vars: OriginalEnvVars = {};
    expect(Object.prototype.hasOwnProperty.call(vars, 'PORT')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(vars, 'HYPERNEO_PORT')).toBe(false);
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

describe('ProviderService.restoreEnvVars — HYPERNEO_PORT restoration', () => {
  let service: ProviderService;

  beforeEach(() => {
    service = new ProviderService();
  });

  afterEach(() => {
    if (ORIGINAL_HYPERNEO_PORT !== undefined) {
      process.env.HYPERNEO_PORT = ORIGINAL_HYPERNEO_PORT;
    } else {
      delete process.env.HYPERNEO_PORT;
    }
  });

  it('restores HYPERNEO_PORT to the original value when original.HYPERNEO_PORT was defined', () => {
    process.env.HYPERNEO_PORT = 'mutated-during-query';

    const original: OriginalEnvVars = { HYPERNEO_PORT: '9983' };
    service.restoreEnvVars(original);

    expect(process.env.HYPERNEO_PORT).toBe('9983');
  });

  it('deletes HYPERNEO_PORT when original.HYPERNEO_PORT was explicitly undefined', () => {
    process.env.HYPERNEO_PORT = 'leaked-hyperneo-port';

    const original: OriginalEnvVars = { HYPERNEO_PORT: undefined };
    service.restoreEnvVars(original);

    expect(process.env.HYPERNEO_PORT).toBeUndefined();
  });

  it('does NOT touch HYPERNEO_PORT when the key is absent from the original object', () => {
    process.env.HYPERNEO_PORT = 'should-be-untouched';

    const original: OriginalEnvVars = {};
    service.restoreEnvVars(original);

    expect(process.env.HYPERNEO_PORT).toBe('should-be-untouched');
  });

  it('restores both PORT and HYPERNEO_PORT together in one restoreEnvVars call', () => {
    process.env.PORT = 'wrong-port';
    process.env.HYPERNEO_PORT = 'wrong-hyperneo-port';

    const original: OriginalEnvVars = { PORT: '8399', HYPERNEO_PORT: '9983' };
    service.restoreEnvVars(original);

    expect(process.env.PORT).toBe('8399');
    expect(process.env.HYPERNEO_PORT).toBe('9983');
  });
});
