import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('./ci-gate.sh', import.meta.url).pathname;

const ALL_RESULTS = {
  CI_GATE_RESULT_CHECK: 'success',
  CI_GATE_RESULT_CHANGES: 'success',
  CI_GATE_RESULT_TEST_DAEMON_ONLINE: 'success',
  CI_GATE_RESULT_TEST_DAEMON_SHARED_UNIT: 'success',
  CI_GATE_RESULT_TEST_WEB: 'success',
  CI_GATE_RESULT_BUILD: 'success',
  CI_GATE_RESULT_DENO_BOOT_SMOKE: 'success',
  CI_GATE_RESULT_WINDOWS_COMPILED_SMOKE: 'success',
};

const runGate = (results: Record<string, string>) =>
  spawnSync('bash', [SCRIPT], { env: { ...process.env, ...results }, encoding: 'utf8' });

describe('ci-gate.sh', () => {
  it('passes when every need succeeded', () => {
    const r = runGate(ALL_RESULTS);
    expect(r.status).toBe(0);
  });

  it('fails when a required need was cancelled', () => {
    for (const key of Object.keys(ALL_RESULTS)) {
      const r = runGate({ ...ALL_RESULTS, [key]: 'cancelled' });
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toContain('cancelled');
    }
  });

  it('still passes when a path-filtered need was skipped', () => {
    const r = runGate({
      ...ALL_RESULTS,
      CI_GATE_RESULT_TEST_WEB: 'skipped',
      CI_GATE_RESULT_WINDOWS_COMPILED_SMOKE: 'skipped',
    });
    expect(r.status).toBe(0);
  });

  it('fails on failure', () => {
    const r = runGate({ ...ALL_RESULTS, CI_GATE_RESULT_CHECK: 'failure' });
    expect(r.status).toBe(1);
  });

  it('fails on a missing result instead of passing silently', () => {
    const results = { ...ALL_RESULTS };
    delete (results as Record<string, string>).CI_GATE_RESULT_TEST_WEB;
    const r = runGate(results);
    expect(r.status).toBe(1);
  });
});
