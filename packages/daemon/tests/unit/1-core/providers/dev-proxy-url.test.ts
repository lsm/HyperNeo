import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { devProxyBaseUrl } from '../../../../src/lib/provider-service.ts';

describe('dev proxy base url', () => {
  beforeEach(() => {
    delete process.env.VERIFY_MOCK_PORT;
  });

  afterEach(() => {
    delete process.env.VERIFY_MOCK_PORT;
  });

  test('defaults to the standard mock port', () => {
    expect(devProxyBaseUrl()).toBe('http://127.0.0.1:8000');
  });

  test('follows VERIFY_MOCK_PORT for parallel verify sessions', () => {
    process.env.VERIFY_MOCK_PORT = '8123';
    expect(devProxyBaseUrl()).toBe('http://127.0.0.1:8123');
  });
});
