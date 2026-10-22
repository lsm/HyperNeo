import { expect, test } from 'bun:test';
import { waitForSdkMessages } from '../../../helpers/daemon-actions';
import type { DaemonServerContext } from '../../../helpers/daemon-server';

test('SDK page readiness waits for both requested steer messages despite older message counts', async () => {
  const prior = Array.from({ length: 5 }, (_, index) => ({
    type: 'assistant',
    uuid: `old-${index}`,
  }));
  const steers = ['first-steer', 'second-steer'].map((uuid) => ({ type: 'user', uuid }));
  let reads = 0;
  const daemon = {
    messageHub: {
      request: async () => ({
        sdkMessages: ++reads === 1 ? prior : [...prior, ...steers],
        hasMore: false,
      }),
    },
  } as unknown as DaemonServerContext;
  const options = {
    minCount: 5,
    timeout: 1000,
    userMessageIds: steers.map((message) => message.uuid),
  };
  const page = await waitForSdkMessages(daemon, 'synthetic-session', options);
  expect(page.sdkMessages).toEqual(expect.arrayContaining(steers));
});
