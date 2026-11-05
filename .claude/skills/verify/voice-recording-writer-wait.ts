import { appendFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export function installRecordingWait(run: string, thread: string, waitTarget: 'reserve' | 'dispatch' = 'reserve'): void {
  const prepare = Database.prototype.prepare;
  let first = true;
  Database.prototype.prepare = function(sql, options) {
    const statement = prepare.call(this,sql,options);
    if (!sql.includes('voice_recordings')) return statement;
    return new Proxy(statement,{get(target,property) {
      const value=Reflect.get(target,property,target);
      if(property!=='run' && property!=='get') return typeof value==='function' ? value.bind(target) : value;
      return (...args: unknown[])=>{
        const matches = waitTarget === 'reserve' ? sql.trimStart().startsWith('INSERT') : sql.trimStart().startsWith('UPDATE voice_recordings SET dispatched_at =');
        const modeledWaitMs = first && matches ? 1200 : 0;
        if(modeledWaitMs) { first=false; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,modeledWaitMs); }
        const result=Reflect.apply(value,target,args);
        appendFileSync(joinPath(run),JSON.stringify({thread,sql,operation:property,modeledWaitMs})+'\n');
        return result;
      };
    }});
  };
}
function joinPath(run: string): string { return `${run}/evidence/recording-sql.jsonl`; }
