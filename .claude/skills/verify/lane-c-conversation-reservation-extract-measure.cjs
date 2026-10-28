const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require(process.cwd() + '/node_modules/typescript');
const manifest = JSON.parse(execFileSync('bun', ['.claude/skills/verify/lane-c-human-reset-command-measure.cjs'], {encoding:'utf8'}));
const helper = 'packages/daemon/src/storage/repositories/human-reset-conversation-reservation.ts';
const paths = ['packages/daemon/src/storage/repositories/neo-repository.ts','packages/daemon/src/storage/repositories/human-device-reset-repository.ts',...(fs.existsSync(helper)?[helper]:[])];
const expected = 'INSERT OR IGNORE INTO neo_conversation (singleton, id, created_at) VALUES (1, ?, ?)';
const statements = [];
const lexical = text => ({prepare:[...text.matchAll(/\.prepare\s*\(/g)].length,run:[...text.matchAll(/\.run\s*\(/g)].length});
const delta = {prepare:0,run:0};
for (const file of paths) {
 const text = fs.readFileSync(file,'utf8');
 const old = execFileSync('git',['ls-tree',manifest.base,'--',file],{encoding:'utf8'}).trim() ? execFileSync('git',['show',manifest.base+':'+file],{encoding:'utf8'}) : '';
 const a=lexical(text),b=lexical(old);for (const key of Object.keys(delta))delta[key]+=a[key]-b[key];
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 const visit=node=>{
  if(ts.isStringLiteral(node)&&node.text.startsWith('INSERT OR IGNORE INTO neo_conversation ')){
   if(node.text!==expected)throw new Error('Reservation SQL bytes changed');
   statements.push({file,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,sqlBytes:Buffer.byteLength(node.text),sqlSha256:createHash('sha256').update(node.text).digest('hex')});
  }ts.forEachChild(node,visit);
 };visit(source);
}
const extracted=fs.existsSync(helper);
if(statements.length!==(extracted?1:2)||delta.prepare!==(extracted?-1:0)||delta.run!==(extracted?-1:0))throw new Error('Unexpected extraction SQL accounting');
console.log(JSON.stringify({...manifest,extraction:{statements,lexicalDelta:delta,plannedCombinedWithReceiptLookup:{prepare:0,run:-1},characterization:'Unchanged caller tests compare legacy SQL bytes, arguments, SQLite changes/lastInsertRowid, stored rows and outer rollback before and after extraction.',overlap:'The coordinator explicitly allowed the existing draft overlap to rebase after this extraction.'}},null,2));
