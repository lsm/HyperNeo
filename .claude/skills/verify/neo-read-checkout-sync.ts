import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { getNeoReadCheckoutPath } from '../../../packages/daemon/src/lib/neo/read-checkout-path.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data')));
for (const name of ['bin', 'evidence']) mkdirSync(join(run, name));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = join(run, 'origin.git'), publisher = join(run, 'publisher'), human = join(run, 'human');
git(run, 'init', '--bare', '--initial-branch=main', origin);
git(run, 'init', '--initial-branch=main', publisher);
git(publisher, 'config', 'user.name', 'Synthetic proof');
git(publisher, 'config', 'user.email', 'proof@example.invalid');
writeFileSync(join(publisher, 'answer.txt'), 'version one\n');
git(publisher, 'add', 'answer.txt'); git(publisher, 'commit', '-m', 'Synthetic initial default head');
git(publisher, 'remote', 'add', 'origin', origin); git(publisher, 'push', 'origin', 'main');
git(run, 'clone', origin, human);
writeFileSync(join(human, 'answer.txt'), 'human uncommitted work\n');
const snapshot = () => ({ head: git(human, 'rev-parse', 'HEAD'), remote: git(human, 'rev-parse', 'origin/main'), bytes: readFileSync(join(human, 'answer.txt'), 'utf8'), status: git(human, 'status', '--porcelain') });
const before = snapshot(), initial = git(publisher, 'rev-parse', 'HEAD');
writeFileSync(join(run, 'home', '.gitconfig'), `[url "${origin}"]\n\tinsteadOf = git@github.com:synthetic/neo-read-proof.git\n`);
writeFileSync(join(run, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), root = ${JSON.stringify(run)};
if (args[0] !== 'api') process.exit(2);
const path = args.find(a=>a.startsWith('/repos/') || a === '/user');
if (!path) process.exit(2);
let body=[];
if(path==='/user') body={login:'synthetic'};
else if(path==='/repos/synthetic/neo-read-proof') body={default_branch:'main'};
else if(path==='/repos/synthetic/neo-read-proof/git/ref/heads/main') body={object:{sha:cp.execFileSync('git',['--git-dir',root+'/origin.git','rev-parse','refs/heads/main'],{encoding:'utf8'}).trim()}};
else if(path.includes('/check-runs')) body={check_runs:[]};
else if(!path.startsWith('/repos/synthetic/neo-read-proof/')) process.exit(2);
fs.appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({path})+'\\n');
if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\nX-RateLimit-Remaining: 4900\\r\\n\\r\\n');
process.stdout.write(JSON.stringify(body));
`, { mode: 0o700 });
const fetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No external HTTP in synthetic proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = { mode, initial, humanBefore: before };
try {
 app = await createDaemonApp({config:getConfig({port:0,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),verbose:false});
 await app.jobProcessor.stop(); assert.notEqual(app.server.port,8399);
 const ext = app.extensionManager.getExtension('github') as GitHubEventExtension;
 ext.repo.upsertWatchedRepo({spaceId:'proof-space',owner:'synthetic',repo:'neo-read-proof',pollingEnabled:true});
 await new ExternalEventExtensionConfigStore(app.db.getDatabase()).setGlobalConfig('github',{source:'github',globallyEnabled:true,capabilities:{polling:true,rpcConfig:true}});
 ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
 await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('RPC unavailable'));});
 const poll = () => new Promise<unknown>((done,fail)=>{
  const id=crypto.randomUUID(), timer=setTimeout(()=>fail(new Error('poll RPC deadline')),30000);
  ws!.onmessage=event=>{const m=JSON.parse(String(event.data));if(m.id!==id&&m.requestId!==id)return;clearTimeout(timer);m.error?fail(new Error(JSON.stringify(m.error))):done(m.data);};
  ws!.send(JSON.stringify({id,type:'REQ',method:'space.github.pollOnce',data:{},sessionId:'global',timestamp:new Date().toISOString(),version:'1.0.0'}));
 });
 evidence.firstPoll = await poll();
 const watched=ext.repo.getWatchedRepo('proof-space','synthetic','neo-read-proof');
 assert(watched?.lastPollAt && !watched.pollCursor?.lastPollError, JSON.stringify(watched));
 evidence.pollCursor=watched.pollCursor;
 const path = getNeoReadCheckoutPath('synthetic','neo-read-proof');
 evidence.checkoutPath = path; evidence.created = existsSync(join(path,'.git'));
 if(mode==='verify') {
  assert(evidence.created,'poll did not create Neo read checkout');
  assert.equal(git(path,'rev-parse','HEAD'),initial);
  assert.equal(git(path,'rev-parse','--abbrev-ref','HEAD'), 'HEAD');
 }
 writeFileSync(join(publisher,'answer.txt'),'version two\n');
 git(publisher,'add','answer.txt');git(publisher,'commit','-m','Advance actual default branch');git(publisher,'push','origin','main');
 const advanced = git(publisher,'rev-parse','HEAD'); assert.notEqual(advanced,initial);
 evidence.originAdvanced = advanced; evidence.secondPoll = await poll();
 evidence.humanAfter = snapshot(); assert.deepEqual(evidence.humanAfter,before);
 if(mode==='before') assert(!existsSync(path),'baseline unexpectedly has read checkout');
 else {
  assert.equal(git(path,'rev-parse','HEAD'),advanced);
  assert.equal(git(path,'rev-parse','origin/main'),advanced);
  assert.equal(readFileSync(join(path,'answer.txt'),'utf8'),'version two\n');
  assert.equal(git(path,'status','--porcelain'),'');
  evidence.readHead = advanced; evidence.content = readFileSync(join(path,'answer.txt'),'utf8');
 }
 evidence.verified = true; console.log(JSON.stringify(evidence,null,2));
} finally {
 writeFileSync(join(run,'evidence','read-checkout.json'),JSON.stringify(evidence,null,2));
 ws?.close();await app?.cleanup();globalThis.fetch=fetch;
}
