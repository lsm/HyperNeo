import { describe, expect, it } from 'bun:test';
import daemonPackageJson from '../../../../package.json' with { type: 'json' };
import {
  BUILD_METADATA,
  UNKNOWN_VERSION,
  readBuildMetadata,
} from '../../../../src/lib/build-metadata';

describe('readBuildMetadata', () => {
  it('reads the app version and the pinned Claude SDK version from package metadata', () => {
    expect(
      readBuildMetadata({
        version: '1.2.3',
        dependencies: { '@anthropic-ai/claude-agent-sdk': '0.9.8' },
      })
    ).toEqual({ version: '1.2.3', claudeSdkVersion: '0.9.8' });
  });

  it('falls back to an explicit unknown marker when metadata is missing', () => {
    expect(readBuildMetadata({})).toEqual({
      version: UNKNOWN_VERSION,
      claudeSdkVersion: UNKNOWN_VERSION,
    });
    expect(readBuildMetadata({ version: ' ', dependencies: {} })).toEqual({
      version: UNKNOWN_VERSION,
      claudeSdkVersion: UNKNOWN_VERSION,
    });
  });
});

describe('BUILD_METADATA', () => {
  it('matches the daemon package version and its Claude SDK dependency pin', () => {
    expect(BUILD_METADATA.version).toBe(daemonPackageJson.version);
    expect(BUILD_METADATA.claudeSdkVersion).toBe(
      daemonPackageJson.dependencies['@anthropic-ai/claude-agent-sdk']
    );
    expect(BUILD_METADATA.claudeSdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
