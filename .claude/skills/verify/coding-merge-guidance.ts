import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository, deliverCodingPrEvents } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository, sweepCodingPrs } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { NEO_FOCUSED_DISCUSSION } from '../../../packages/prompts/src/mod.ts';
import { neoPrompt } from '../../../packages/daemon/src/lib/neo/prompt.ts';
import { neoSettingsPackBriefs } from '../../../packages/daemon/src/lib/neo/packs/index.ts';
import { withCodingWorkGoal } from '../../../packages/daemon/src/lib/neo/packs/coding/work-goal.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase(), ledger = new CodingPrLedgerRepository(db);
  const repo = 'synthetic/guidance', url = `https://github.com/${repo}/pull/7`, now = Date.now();
  const row = { repo, number: 7, title: 'Guidance', branch: 'guidance', head: 'a'.repeat(40), closedAt: null };
  await ledger.write('replace', repo, [{ ...row, state: 'waiting_review' }], now);
  await ledger.write('observeSessions', [{ ref: { adapter: 'codex', id: 'synthetic-owner' }, status: { state: 'running' }, lastActivityAt: now,
    remotes: ['git@github.com:synthetic/guidance.git'], branches: ['guidance'], openedPrs: [url] }], now);
  const transitions = await ledger.write('replace', repo, [{ ...row, state: 'approved_green' }], now);
  const messages: { kind: string; text: string }[] = [];
  const delivery = { tell: async (_ref: unknown, _key: string, text: string) => { messages.push({ kind: 'owner', text }); return true; },
    wake: async (_key: string, text: string) => { messages.push({ kind: 'neo', text }); return true; } };
  await deliverCodingPrEvents(new CodingPrEventRepository(db), transitions, delivery);
  for (const minute of [20, 40, 60]) {
    const at = now + minute * 60000;
    await ledger.write('replace', repo, [{ ...row, state: 'approved_green' }], at);
    await sweepCodingPrs(new CodingPrSweepRepository(db), delivery, at);
  }
  evidence.push({ surface: 'production PR event/sweep with real daemon storage and captured delivery boundary', messages });
  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert(message.text.includes('required merge gates'), message.text);
    assert(!message.text.includes('Merge it now'), message.text);
  }
  for (const message of messages.filter(message => message.kind === 'owner')) assert(message.text.includes('--match-head-commit'), message.text);
  const prompt = withCodingWorkGoal('Finish this change.', { workId: 'synthetic-work', goal: 'Deliver change', doneWhen: 'PR merged' });
  evidence.push({ surface: 'production coding worker goal formatter', prompt });
  assert(prompt.includes('gh pr merge <number> --squash --match-head-commit <head_sha>'));
  assert(prompt.includes('immediately before'));
  assert(prompt.includes('Never enable GitHub auto-merge'));
  assert(prompt.includes('remaining recorded deployment or Verify smoke condition'));
  const briefing = neoPrompt(neoSettingsPackBriefs());
  evidence.push({ surface: 'production root Neo coding pack briefing', prompt: briefing });
  assert(briefing.includes('neo.coding.merge.prepare'));
  assert(briefing.includes('neo.coding.smoke'));
  assert(!/holder|consult|forward|dispatch/i.test(briefing.replace(NEO_FOCUSED_DISCUSSION, '')));
  evidence.push({ verified: true });
  console.log('PASS: review/CI notifications require merge gates; worker prompt requires a freshly read SHA-pinned manual command. No merge executed.');
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally { await app.cleanup(); globalThis.fetch = originalFetch; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
