import { appendFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export function installRecoveryWait(run: string, thread: string, whitespace = false): void {
  const prepare = Database.prototype.prepare;
  let first = true;
  Database.prototype.prepare = function(sql, options) {
    if (whitespace && sql.includes('tool_continuation_recovery')) sql = `\n  ${sql}`;
    const statement = prepare.call(this,sql,options);
    if (!sql.includes('tool_continuation_recovery')) return statement;
    return new Proxy(statement,{get(target,property) {
      const value=Reflect.get(target,property,target);
      if(property!=='run') return typeof value==='function' ? value.bind(target) : value;
      return (...args: unknown[])=>{
        const modeledWaitMs = first && sql.trimStart().startsWith('INSERT') ? 1200 : 0;
        const started = performance.now();
        if (modeledWaitMs) { first=false; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,modeledWaitMs); }
        const waitElapsedMs = performance.now() - started;
        const result=Reflect.apply(value,target,args);
        appendFileSync(joinPath(run),JSON.stringify({thread,sql,operation:property,modeledWaitMs,waitElapsedMs})+'\n');
        return result;
      };
    }});
  };
}
function joinPath(run: string): string { return `${run}/evidence/recovery-sql.jsonl`; }
