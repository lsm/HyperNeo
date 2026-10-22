import { describe, expect, it } from 'bun:test';
import daemonPackageJson from '../../../../package.json' with { type: 'json' };
import { execFileSync } from 'node:child_process';
import {
  BUILD_METADATA,
  UNKNOWN_VERSION,
  readBuildCommit,
  readReleaseBuildCommit,
  readBuildMetadata,
} from '../../../../src/lib/build-metadata';

const SHA = 'a'.repeat(40);

describe('readBuildMetadata', () => {
  it('reads the app version and the pinned Claude SDK version from package metadata', () => {
    expect(
      readBuildMetadata({
        version: '1.2.3',
        dependencies: { '@anthropic-ai/claude-agent-sdk': '0.9.8' },
      })
    ).toEqual({ version: '1.2.3', claudeSdkVersion: '0.9.8', commit: UNKNOWN_VERSION });
  });

  it('falls back to an explicit unknown marker when metadata is missing', () => {
    expect(readBuildMetadata({})).toEqual({
      version: UNKNOWN_VERSION,
      claudeSdkVersion: UNKNOWN_VERSION,
      commit: UNKNOWN_VERSION,
    });
    expect(readBuildMetadata({ version: ' ', dependencies: {} })).toEqual({
      version: UNKNOWN_VERSION,
      claudeSdkVersion: UNKNOWN_VERSION,
      commit: UNKNOWN_VERSION,
    });
  });

  it('carries the build commit', () => {
    expect(readBuildMetadata({ version: '1.2.3' }, SHA).commit).toBe(SHA);
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

describe('readBuildCommit', () => {
  it('prefers HYPERNEO_BUILD_COMMIT over the source checkout', () => {
    expect(readBuildCommit({ HYPERNEO_BUILD_COMMIT: ` ${SHA} ` }, () => 'b'.repeat(40))).toBe(SHA);
  });

  it('reads the source checkout HEAD', () => {
    expect(readBuildCommit({}, () => `${SHA}\n`)).toBe(SHA);
  });

  it('reports nothing when git fails or prints something other than a commit', () => {
    expect(
      readBuildCommit({}, () => {
        throw new Error('not a git repository');
      })
    ).toBeUndefined();
    expect(readBuildCommit({}, () => 'fatal: bad revision')).toBeUndefined();
  });
});

describe('BUILD_METADATA commit', () => {
  it('is the HEAD of the checkout the daemon runs from', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(BUILD_METADATA.commit).toBe(process.env.HYPERNEO_BUILD_COMMIT?.trim() || head);
  });
});

describe('release build commit shared by web and daemon', () => {
  it.each([
    { environment: { HYPERNEO_BUILD_COMMIT: 'b'.repeat(40) }, expected: 'b'.repeat(40) },
    {
      environment: { GITHUB_SHA: 'c'.repeat(40), HYPERNEO_BUILD_COMMIT: 'b'.repeat(40) },
      expected: 'c'.repeat(40),
    },
    { environment: {}, expected: SHA },
  ])('reports the same release commit for $expected', ({ environment, expected }) => {
    expect(readReleaseBuildCommit(environment, () => SHA)).toBe(expected);
  });
});
