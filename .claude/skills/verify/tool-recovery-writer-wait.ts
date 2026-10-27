import { appendFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export function installRecoveryWait(run: string, thread: string): void {
  const prepare = Database.prototype.prepare;
  let first = true;
  Database.prototype.prepare = function(sql, options) {
    const statement = prepare.call(this,sql,options);
    if (!sql.includes('tool_continuation_recovery')) return statement;
    return new Proxy(statement,{get(target,property) {
      const value=Reflect.get(target,property,target);
      if(property!=='run') return typeof value==='function' ? value.bind(target) : value;
      return (...args: unknown[])=>{
        if(first && sql.startsWith('INSERT')) { first=false; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200); }
        const result=Reflect.apply(value,target,args);
        appendFileSync(joinPath(run),JSON.stringify({thread,sql,operation:property})+'\n');
        return result;
      };
    }});
  };
}
function joinPath(run: string): string { return `${run}/evidence/recovery-sql.jsonl`; }
