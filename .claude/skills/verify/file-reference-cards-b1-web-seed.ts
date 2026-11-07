import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const [directory,phase,rootSession,artifact]=process.argv.slice(2);
const run=realpathSync(directory);
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.HOME,join(run,'home'));
const child=Bun.spawn([process.execPath,fileURLToPath(new URL('./live-file-web-a4-seed.ts',import.meta.url)),run,phase,...(phase==='publish'?[rootSession,artifact]:[])],{env:process.env,stdout:'pipe',stderr:'inherit'});
const output=await new Response(child.stdout).text();
assert.equal(await child.exited,0,output);
if(phase==='publish'){
  const db=new Database(join(run,'data/daemon.db'));
  try{
    const store=new NeoAskTodoRepository(db);
    const todo=store.getTodo('todo');
    assert(todo);
    const mention='`'+join(run,'workspace/current notes.md')+'`';
    store.updateTodo(todo,{instruction:`The delivered file is ${mention}.`,report:`Read ${mention} twice: ${mention}.`},Date.now());
    store.askQuestion('file-question','ask',{text:`Please read ${mention} twice: ${mention}. [PR](https://github.com/acme/demo/pull/7)`,document:`Full report also links ${mention}.`,kind:'reply',options:null,multiple:false,noLabel:null,yesLabel:null,startTodos:null,sourceSession:{adapter:'hyperneo',id:'worker',name:'metadata-only.md',label:'metadata-only.md',provider:'synthetic',link:null}},Date.now());
  }finally{db.close();}
  const data=JSON.parse(readFileSync(join(run,'evidence/live-publication.json'),'utf8'));
  writeFileSync(join(run,'evidence/file-card-sources.json'),JSON.stringify({...data,todoId:'todo',questionId:'file-question'}));
}
console.log('seeded synthetic file-card '+phase);
