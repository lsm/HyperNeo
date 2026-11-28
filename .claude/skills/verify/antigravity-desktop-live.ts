import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  antigravityDesktopControlAvailable,
  callAntigravityDesktop,
  readAntigravityDesktopEndpoint,
} from '../../../packages/daemon/src/lib/drivers/antigravity-desktop-channel.ts';
import {
  antigravityDesktopStatePath,
  createAntigravityDesktopDiscovery,
} from '../../../packages/daemon/src/lib/drivers/antigravity-desktop-discovery.ts';
import type { WorkCallContext } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { readAntigravityDesktop } from '../../../packages/daemon/src/storage/antigravity-desktop-read.ts';

const [attended, id, evidence] = process.argv.slice(2);
assert(attended === '--attended' && id && evidence, 'Use --attended CONVERSATION_ID EVIDENCE_DIR for a disposable App conversation.');
assert.notEqual(process.env.NODE_ENV, 'test', 'This proof drives the running App, not the isolated daemon.');
mkdirSync(evidence, { recursive: true });
const home = homedir();
const statePath = antigravityDesktopStatePath(home);
const adapter = createAntigravityDesktopDiscovery(
  async (query) => readAntigravityDesktop({ statePath, query }).sessions,
  hostname(),
  { homeDir: home, available: () => antigravityDesktopControlAvailable(home) }
);
const context: WorkCallContext = { caller: { source: 'rpc' }, from: 'chat' };
const ref = { adapter: 'antigravity-desktop', id };
const observed: Record<string, unknown> = { id, capabilities: adapter.capabilities };
type Step = { type: string; status: string; userInput?: { userResponse?: string }; plannerResponse?: { response?: string } };
const Steps = { safeParse: (data: unknown) => ({ success: true, data: data as { steps: Step[] } }) } as never;
const endpoint = readAntigravityDesktopEndpoint(home);
assert(endpoint, 'Open Antigravity Desktop first.');
const steps = async () => {
  const result = await callAntigravityDesktop(endpoint, 'GetCascadeTrajectorySteps', { cascadeId: id }, Steps);
  assert(result.ok, 'steps');
  return (result.value as { steps: Step[] }).steps.map((step) => ({
    type: step.type.replace('CORTEX_STEP_TYPE_', ''),
    status: step.status.replace('CORTEX_STEP_STATUS_', ''),
    text: (step.userInput?.userResponse ?? step.plannerResponse?.response ?? '').slice(0, 80),
  }));
};
try {
  assert.deepEqual(adapter.capabilities, ['find', 'send']);
  const [found] = (await adapter.find({ id, includeClosed: true, limit: 1 }))[0]?.work ?? [];
  assert.equal(found?.ref.id, id, 'The conversation must be in the App catalog.');
  observed.title = found.title;
  const initial = await steps();
  const before = initial.length;
  observed.before = initial;
  const message = `Reply with the single word SENT-${Date.now().toString(36)}.`;
  const sent = await adapter.send!(ref, message, context);
  observed.send = sent;
  assert(sent.ok && sent.value.delivered, `send: ${JSON.stringify(sent)}`);
  const answered = (list: Awaited<ReturnType<typeof steps>>) => {
    const input = list.findIndex((step, index) => index >= before && step.text === message);
    return input >= 0 && list.slice(input + 1).some((step) => step.type === 'PLANNER_RESPONSE' && step.status === 'DONE');
  };
  const deadline = Date.now() + 90_000;
  let after = await steps();
  while (Date.now() < deadline && !answered(after)) {
    await Bun.sleep(1000);
    after = await steps();
  }
  observed.after = after.slice(before);
  assert(answered(after), 'The App must run the sent message and reply.');
  const unknown = await adapter.send!({ ...ref, id: 'no-such-conversation' }, 'x', context);
  observed.unknown = unknown;
  assert(!unknown.ok && unknown.reason === 'not_found' && unknown.notSent);
  observed.passed = true;
  console.log('PASS: sent to the running App and saw its reply.');
} finally {
  writeFileSync(join(evidence, 'antigravity-desktop-send-live.json'), JSON.stringify(observed, null, 2));
}
