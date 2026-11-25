import { describe, expect, it } from 'vitest';
import {
  isReplyCommand,
  replyCommandPermission,
} from '../../../../src/lib/drivers/reply-command-permission.ts';

const options = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'deny', kind: 'reject_once' },
];
const allowed = { outcome: { outcome: 'selected', optionId: 'allow' } };
const cancelled = { outcome: { outcome: 'cancelled' } };

describe('replyCommandPermission', () => {
  it('allows one hyperneo send reply command', () => {
    expect(
      replyCommandPermission(
        options,
        "hyperneo send session:abc --from antigravity-cli:w1 --kind done 'All done.'"
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
    expect(replyCommandPermission(options, command)).toEqual(cancelled);
  });

  it('tells a reply command apart for drivers with their own permission shape', () => {
    expect(isReplyCommand('hyperneo send session:abc --from copilot-cli:c1 --kind done ok')).toBe(
      true
    );
    expect(isReplyCommand('hyperneo send session:abc hi; id')).toBe(false);
    expect(isReplyCommand(undefined)).toBe(false);
  });

  it('cancels an unknown command or a request without an allow option', () => {
    expect(replyCommandPermission(options, undefined)).toEqual(cancelled);
    expect(replyCommandPermission([options[1]], 'hyperneo send session:abc hi')).toEqual(cancelled);
  });
});
