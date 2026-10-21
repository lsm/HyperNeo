import { describe, expect, test, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ARTIFACT_DEFAULT_LIMITS } from '@hyperneo/shared/types/artifact-file';
import {
  admitArtifactStorage,
  gateArtifactSize,
  gateArtifactQuota,
} from '../../../../src/lib/artifacts/capture-admission.ts';
import { createArtifactCaptureStore } from '../../../../src/lib/artifacts/capture-store.ts';

const limits = { ...ARTIFACT_DEFAULT_LIMITS, artifactBytes: 100, retainedBytes: 200 };
describe('artifact capture storage', () => {
  test('pins size and concurrent reservation gates before any staging write', () => {
    expect(gateArtifactSize(100, limits)).toEqual({ value: 100 });
    expect(gateArtifactSize(101, limits)).toMatchObject({
      reason: { accepted: false, reason: 'size_limit' },
    });
    expect(gateArtifactQuota(50, limits, 100, 51)).toEqual({
      reason: { accepted: false, reason: 'quota_full' },
    });
    expect(admitArtifactStorage(50, limits, 100, 50)).toBe(50);
    expect(admitArtifactStorage(101, limits, 200, 0)).toMatchObject({
      accepted: false,
      reason: 'size_limit',
    });
  });
  test('proves native complete bytes, immutable dedup, quota, interruption and recovery', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-capture-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [resolve('../../.claude/skills/verify/preview-capture.ts'), root],
        {
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        exactBytes: true,
        deduplicated: true,
        quotaReserved: true,
        sourceChangeRefused: true,
        interruptionsRetained: true,
        restartPreserved: true,
        actualProcessCrash: true,
        interruptedCommitRetried: true,
        storedExcessLinksRefused: true,
        sharedInodeCountedOnce: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('cannot stage source bytes without an available descriptor backend', async () => {
    if (process.versions.bun) {
      expect(admitArtifactStorage(201, limits, 0, 0)).toMatchObject({
        accepted: false,
        reason: 'size_limit',
      });
      return;
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-unavailable-')));
    const unavailableDirectories = spyOn(fs, 'open').mockRejectedValue(
      new Error('unsupported directory sync')
    );
    try {
      const store = await createArtifactCaptureStore(join(root, 'artifacts'));
      expect(await store.capture('/synthetic', ['report.bin'])).toEqual({
        accepted: false,
        reason: 'safe_open_unavailable',
      });
      expect((await store.inspect()).entries).toEqual([]);
    } finally {
      unavailableDirectories.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
