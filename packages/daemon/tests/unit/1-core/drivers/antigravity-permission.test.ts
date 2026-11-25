import { describe, expect, it } from 'vitest';
import { antigravityPermissionOutcome } from '../../../../src/lib/drivers/antigravity-permission.ts';

const request = (CommandLine: string, kind = 'execute') => ({
  sessionId: 's1',
  toolCall: { kind, name: 'run_command', rawInput: { CommandLine } },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
});
const cancelled = { outcome: { outcome: 'cancelled' } };

describe('antigravityPermissionOutcome', () => {
  it('reads the command line from the Antigravity request', () => {
    expect(antigravityPermissionOutcome(request('hyperneo send session:abc hi'))).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(antigravityPermissionOutcome(request('rm -rf ~'))).toEqual(cancelled);
  });

  it('cancels non-command tools and malformed requests', () => {
    expect(antigravityPermissionOutcome(request('hyperneo send session:abc hi', 'edit'))).toEqual(
      cancelled
    );
    expect(antigravityPermissionOutcome(undefined)).toEqual(cancelled);
  });
});
