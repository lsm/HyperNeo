import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { pcm16Wav } from '../../../packages/daemon/src/lib/voice/stream-relay.ts';
import { installRecordingWait } from './voice-recording-writer-wait.ts';

const run = process.argv.at(-1)!;
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const NativeWorker = globalThis.Worker;
const fixture = join(run, 'writer.ts');
writeFileSync(fixture, `import { installRecordingWait } from ${JSON.stringify(pathToFileURL(resolve('.claude/skills/verify/voice-recording-writer-wait.ts')).href)}; installRecordingWait(${JSON.stringify(run)}, 'worker'); const pending=[]; globalThis.onmessage=e=>pending.push(e); await import(${JSON.stringify(pathToFileURL(resolve('packages/daemon/src/storage/db-gateway/db-gateway-worker.ts')).href)}); const dispatch=globalThis.onmessage; for(const event of pending) dispatch(event);`);
globalThis.Worker = function(url: string | URL, options?: WorkerOptions) {
  return new NativeWorker(String(url).endsWith('/db-gateway-worker.ts') ? pathToFileURL(fixture).href : url, options);
} as unknown as typeof Worker;
let calls = 0;
const asr = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  await request.formData(); calls++;
  await Bun.sleep(100);
  return Response.json({ text: 'Synthetic retained voice transcript' });
} });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
let probe: ReturnType<typeof spawn> | undefined;
const evidence: Record<string, unknown> = { runtime: Bun.version, modeledWaitMs: 1200 };
try {
  app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true, disableGoalProcessing: true, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const url = `ws://127.0.0.1:${app.server.port}/ws`;
  socket = new WebSocket(url);
  await new Promise<void>((done, fail) => { socket!.onopen=()=>done(); socket!.onerror=()=>fail(new Error('RPC connection failed')); });
  const pending = new Map<string, { done(value: unknown): void; fail(error: Error): void }>();
  socket.onmessage = ({data}) => { const reply=JSON.parse(String(data)); const entry=pending.get(reply.requestId ?? reply.id); if(entry) { pending.delete(reply.requestId ?? reply.id); reply.error ? entry.fail(new Error(JSON.stringify(reply.error))) : entry.done(reply.data); } };
  const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
    const id=crypto.randomUUID(), timer=setTimeout(()=>{pending.delete(id);fail(new Error(`timeout: ${method}`));},10000);
    pending.set(id,{done: value=>{clearTimeout(timer);done(value);},fail:error=>{clearTimeout(timer);fail(error);}});
    socket!.send(JSON.stringify({id,type:'REQ',sessionId:'global',method,data,timestamp:new Date().toISOString(),version:'1.0.0'}));
  });
  await rpc('settings.global.update', { updates: { voice: { enabled: true, endpoint: `http://127.0.0.1:${asr.port}/v1/audio/transcriptions`, model: 'fake', allowPrivateNetwork: true } } });
  probe = spawn(process.execPath, ['-e', `const ws=new WebSocket(${JSON.stringify(url)});let stop=false,id=0,at=0;const samples=[];const send=()=>{if(stop){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++id),type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if((r.requestId??r.id)!==String(id))return;if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);};process.stdin.on('data',()=>{stop=true;});setTimeout(()=>process.exit(2),20000).unref();`], { env:process.env, stdio:['pipe','pipe','pipe'] });
  let output='', errors='';
  probe.stdout!.on('data',data=>{output+=String(data);}); probe.stderr!.on('data',data=>{errors+=String(data);});
  const exited=new Promise((done,fail)=>{probe!.once('exit',done);probe!.once('error',fail);});
  for(let n=0;!output.includes('READY') && n<500;n++) await Bun.sleep(10);
  assert(output.includes('READY'),errors);
  installRecordingWait(run, 'main');
  const request={recordingId:crypto.randomUUID(),audioBase64:Buffer.from(pcm16Wav(new Uint8Array(3200))).toString('base64'),mimeType:'audio/wav'};
  const [first, concurrent] = await Promise.all([rpc('voice.transcribe',request),rpc('voice.transcribe',request)]);
  const replay=await rpc('voice.transcribe',request);
  await assert.rejects(()=>rpc('voice.transcribe',{...request,audioBase64:Buffer.from('changed').toString('base64')}), /different audio/);
  probe.stdin!.end('stop'); assert.equal(await exited,0,errors);
  const health=JSON.parse(output.trim().split('\n').at(-1)!).samples as number[];
  const writes=readFileSync(join(run,'evidence/recording-sql.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  Object.assign(evidence,{first,concurrent,replay,calls,maxHealthMs:Math.max(...health),healthReplies:health.length,writes});
  assert.deepEqual(first,{text:'Synthetic retained voice transcript'});
  assert.deepEqual(concurrent,first); assert.deepEqual(replay,first); assert.equal(calls,1);
  assert(writes.some(row=>row.operation==='run' && row.sql.startsWith('INSERT')));
  assert(writes.every(row=>row.thread==='worker'),'Recording SQL still runs on main');
  assert(Number(evidence.maxHealthMs)<250, 'health delayed by recording storage');
  evidence.passed=true;
} finally {
  socket?.close(); probe?.kill(); await app?.cleanup(); asr.stop(true); globalThis.Worker=NativeWorker;
  writeFileSync(join(run,'evidence/observed.json'),JSON.stringify(evidence,null,2));
}
