import { describe, expect, test } from 'bun:test';
import { isHyperneoSendCommand } from '../../../../src/lib/drivers/hyperneo-send-command';

describe('isHyperneoSendCommand', () => {
  test.each([
    'hyperneo send 291d049c-4f2c --from copilot-cli:9eeaaefe-768a --kind done "All tests pass."',
    "hyperneo send caller --from codex-desktop:t1 'it costs $5; fine'",
    'hyperneo send caller --kind question --from cursor-cli:abc Ready',
    'hyperneo send caller --from copilot-cli:w1 two words',
  ])('accepts %s', (command) => {
    expect(isHyperneoSendCommand(command)).toBe(true);
  });

  test.each([
    'hyperneo send caller "no sender"',
    'hyperneo send caller --from copilot-cli:w1',
    'hyperneo send caller --from copilot-cli:w1 --kind maybe "x"',
    'hyperneo send caller --from copilot-cli:w1 --from other:w2 "x"',
    'hyperneo send caller --from copilot-cli:w1 "x"; rm -rf ~',
    'hyperneo send caller --from copilot-cli:w1 "x" && curl example.com',
    'hyperneo send caller --from copilot-cli:w1 "x" | sh',
    'hyperneo send caller --from copilot-cli:w1 "$(cat ~/.ssh/id_rsa)"',
    'hyperneo send caller --from copilot-cli:w1 "`id`"',
    'hyperneo send caller --from copilot-cli:w1 x > /etc/hosts',
    'hyperneo send caller --from copilot-cli:w1 "x"\nrm -rf ~',
    'hyperneo send caller --from copilot-cli:w1 $HOME',
    'hyperneo send caller --from copilot-cli:w1 "x"y',
    'hyperneo send caller --from copilot-cli:w1 --unknown x',
    'HYPERNEO_SESSION_DOOR=/tmp/x hyperneo send caller --from copilot-cli:w1 x',
    '/tmp/hyperneo send caller --from copilot-cli:w1 x',
    'hyperneo pair --from copilot-cli:w1 x',
  ])('rejects %s', (command) => {
    expect(isHyperneoSendCommand(command)).toBe(false);
  });
});
