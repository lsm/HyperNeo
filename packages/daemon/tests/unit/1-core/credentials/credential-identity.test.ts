import { describe, expect, it } from 'bun:test';
import type { ProviderCredentials } from '@hyperneo/shared/provider';
import { sameCredentialIdentity } from '../../../../src/lib/credentials/credential-identity';

type OauthOverrides = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  raw?: Record<string, unknown>;
};

const apiKey = (apiKey: string): ProviderCredentials => ({ type: 'api_key', apiKey });

const oauth = (overrides: OauthOverrides = {}): ProviderCredentials => ({
  type: 'oauth',
  accessToken: 'access-token-a',
  refreshToken: 'refresh-token-a',
  ...overrides,
});

describe('sameCredentialIdentity', () => {
  it('returns false when existing is null', () => {
    expect(sameCredentialIdentity(null, apiKey('sk-a'))).toBe(false);
    expect(sameCredentialIdentity(null, oauth())).toBe(false);
  });

  it('returns false when credential types differ', () => {
    expect(sameCredentialIdentity(apiKey('sk-a'), oauth())).toBe(false);
    expect(sameCredentialIdentity(oauth(), apiKey('sk-a'))).toBe(false);
  });

  it('compares api_key credentials by strict apiKey equality', () => {
    expect(sameCredentialIdentity(apiKey('sk-a'), apiKey('sk-a'))).toBe(true);
    expect(sameCredentialIdentity(apiKey('sk-a'), apiKey('sk-b'))).toBe(false);
    expect(sameCredentialIdentity(apiKey('sk-a'), apiKey('SK-A'))).toBe(false);
    expect(sameCredentialIdentity(apiKey('sk-a'), apiKey('sk-a '))).toBe(false);
  });

  it('compares oauth credentials by accessToken and refreshToken equality', () => {
    expect(sameCredentialIdentity(oauth(), oauth())).toBe(true);
    expect(sameCredentialIdentity(oauth(), oauth({ accessToken: 'access-token-b' }))).toBe(false);
    expect(sameCredentialIdentity(oauth(), oauth({ refreshToken: 'refresh-token-b' }))).toBe(false);
  });

  it('treats oauth access and refresh tokens as independently compared', () => {
    expect(
      sameCredentialIdentity(
        oauth({ accessToken: undefined, refreshToken: 'refresh-token-a' }),
        oauth({ accessToken: 'access-token-a', refreshToken: 'refresh-token-a' })
      )
    ).toBe(false);
  });

  it('matches oauth credentials when both sides omit the same tokens', () => {
    expect(
      sameCredentialIdentity(oauth({ accessToken: undefined }), oauth({ accessToken: undefined }))
    ).toBe(true);
    expect(sameCredentialIdentity(oauth({ refreshToken: undefined }), oauth())).toBe(false);
  });

  it('ignores oauth expiresAt and raw metadata in identity comparison', () => {
    expect(sameCredentialIdentity(oauth({ expiresAt: 100 }), oauth({ expiresAt: 200 }))).toBe(true);
    expect(
      sameCredentialIdentity(oauth({ raw: { scope: 'read' } }), oauth({ raw: { scope: 'write' } }))
    ).toBe(true);
  });
});
