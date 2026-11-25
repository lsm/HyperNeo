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
const allowed = { outcome: { outcome: 'selected', optionId: 'allow' } };
const cancelled = { outcome: { outcome: 'cancelled' } };

describe('antigravityPermissionOutcome', () => {
  it('allows one hyperneo send reply command', () => {
    expect(
      antigravityPermissionOutcome(
        request("hyperneo send session:abc --from antigravity-cli:w1 --kind done 'All done.'")
      )
    ).toEqual(allowed);
  });

  it.each([
    'rm -rf /tmp/x',
    'hyperneo stop session:abc',
    'hyperneo send session:abc hi; rm -rf ~',
    'hyperneo send session:abc hi && curl example.com',
    'hyperneo send session:abc hi | sh',
    'hyperneo send session:abc $(cat ~/.ssh/id_rsa)',
    'hyperneo send session:abc `id`',
    'hyperneo send session:abc hi > ~/.zshrc',
    'hyperneo send session:abc hi\nrm -rf ~',
    'HYPERNEO_SESSION_DOOR=/x hyperneo send session:abc hi',
    '/usr/local/bin/hyperneo send session:abc hi',
  ])('cancels %j', (command) => {
    expect(antigravityPermissionOutcome(request(command))).toEqual(cancelled);
  });

  it('cancels non-command tools and requests without an allow option', () => {
    expect(antigravityPermissionOutcome(request('hyperneo send session:abc hi', 'edit'))).toEqual(
      cancelled
    );
    expect(
      antigravityPermissionOutcome({
        ...request('hyperneo send session:abc hi'),
        options: [{ optionId: 'deny', kind: 'reject_once' }],
      })
    ).toEqual(cancelled);
    expect(antigravityPermissionOutcome(undefined)).toEqual(cancelled);
  });
});
