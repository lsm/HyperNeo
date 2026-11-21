import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { hostname, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copilotDesktopStatePath,
  createCopilotDesktopAdapter,
} from '../../../packages/daemon/src/lib/drivers/copilot-desktop-adapter.ts';
import type { Result, WorkCallContext } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { readCopilotDesktop } from '../../../packages/daemon/src/storage/copilot-desktop-read.ts';

const [attended, model, effort, mode] = process.argv.slice(2);
assert(attended === '--attended' && model && effort, 'Use --attended MODEL EFFORT with approval for this App connection.');
assert(mode === undefined || mode === 'compact');
assert.notEqual(process.env.NODE_ENV, 'test', 'This proof does not run in the isolated daemon.');
const home = homedir();
const folder = mkdtempSync(join(realpathSync(tmpdir()), 'copilot-desktop-proof-'));
const machine = hostname();
const adapter = createCopilotDesktopAdapter(
  async (query, id) => readCopilotDesktop({ query: { ...query, folder }, id, statePath: copilotDesktopStatePath(home) }),
  machine,
  home,
  () => true
);
const context: WorkCallContext = { caller: { source: 'rpc' }, from: 'chat' };

function pass<T>(result: Result<T>, name: string): T {
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  console.log('PASS', name);
  return result.value;
}

async function wait<T>(observe: () => T | Promise<T>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await observe();
    if (result) return result;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error('Expected App evidence did not appear');
}

const work = pass(await adapter.start!({
  place: { machine, folder, name: 'Fixture' },
  title: 'HyperNeo desktop native test',
  message: 'Without using tools, write 850 numbered lines about clouds, each with a distinct sentence.',
  model,
  effort,
}, context), 'start');
const { ref } = work;
const file = join(home, '.copilot', 'session-state', ref.id, 'events.jsonl');
interface Event {
  type: string;
  data?: { selectedModel?: string; reasoningEffort?: string; messageId?: string; outcome?: string; trigger?: string };
}
function events() {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line) as Event | null;
      return typeof event?.type === 'string' ? [event] : [];
    } catch {
      return [];
    }
  });
}
const effective = await wait(() => events().find((event) =>
  event.type === 'session.start' && event.data?.selectedModel && event.data.reasoningEffort
));
assert.equal(effective.data?.selectedModel, model);
assert.equal(effective.data?.reasoningEffort, effort);
console.log('PASS effective runtime settings', model, effort);

const queued = pass(await adapter.queue!(ref, 'Withdraw this test message. Do not use tools.', context), 'queue');
assert(queued.queuedSubmissionId);
const withheld = pass(await adapter.withdraw!(ref, queued.queuedSubmissionId, context), 'withdraw');
assert.equal(withheld.withdrawn, true);
const cancelled = pass(await adapter.stop!(ref, context), 'stop');
assert.equal(cancelled.stopped, true);
await wait(async () => {
  const status = await adapter.status!(ref);
  return status.ok && status.value.status !== 'running' && events().some((event) => event.type === 'abort');
});
const followup = mode === 'compact'
  ? 'Do not use tools. Write 25 numbered sentences about clouds, then finish with HYPERNEO DESKTOP FOLLOWUP OK.'
  : 'Reply exactly HYPERNEO DESKTOP FOLLOWUP OK. Do not use tools.';
const sent = pass(await adapter.send!(ref, followup, context), 'send');
assert(sent.receipt);
await wait(async () => {
  const status = await adapter.status!(ref, undefined, sent.receipt);
  return status.ok && status.value.status !== 'running' &&
    status.value.lastReply?.includes('HYPERNEO DESKTOP FOLLOWUP OK');
}, 45000);
assert(!events().some((event) => event.type === 'user.message' && event.data?.messageId === queued.queuedSubmissionId));
if (mode === 'compact') {
  const before = events().filter((event) => event.type === 'session.compaction_complete').length;
  assert.equal(pass(await adapter.compact!(ref, context), 'compact').compacted, true);
  await wait(() => events().filter((event) => event.type === 'session.compaction_complete')
    .slice(before).some((event) => event.data?.trigger === 'manual' && event.data.outcome === 'applied'));
  console.log('PASS App journal recorded the applied manual compaction.');
}
pass(await adapter.rename!(ref, 'HyperNeo verified desktop test', context), 'rename');
await wait(async () => {
  const status = await adapter.status!(ref);
  return status.ok && status.value.title === 'HyperNeo verified desktop test';
});
pass(await adapter.archive!(ref, () => null), 'archive');
await wait(async () => {
  const status = await adapter.status!(ref);
  return status.ok && status.value.archived;
});
assert(existsSync(folder));
console.log('PASS 7 operations; effective model and effort, follow-up, queue removal, persisted abort, rename and retained directory');
