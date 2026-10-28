const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.cwd(),'.claude/skills/verify/evidence/lane-c-conversation-reservation-extract');
const metrics = new Set(['coldMs','healthWhileHeldMs','heldMs','concurrentMs','maxLoopLagMs','rssBytes','walBytes','timings','publicResetOperationUnwired','publicResetOperationExercised']);
const semantic = value => Object.fromEntries(Object.entries(value).filter(([key])=>!metrics.has(key)));
const results = [];
for (const runtime of ['bun','deno']) {
 const before=JSON.parse(fs.readFileSync(path.join(root,'before-'+runtime+'.json'),'utf8'));
 const after=JSON.parse(fs.readFileSync(path.join(root,'after-'+runtime+'.json'),'utf8'));
 if(JSON.stringify(semantic(before))!==JSON.stringify(semantic(after)))throw new Error('Native semantic evidence changed: '+runtime);
 if(!after.boundConversationFallbackPreserved||!after.boundConversationReservationRolledBackWithNotice||after.mainSqlAttempts!==0)throw new Error('Native reservation coverage missing');
 results.push({runtime:after.runtime,semanticEvidenceIdentical:true,targetMainSqlAttempts:0,temporaryDataRemoved:after.temporaryDataRemoved});
}
const before=JSON.parse(fs.readFileSync(path.join(root,'before-measurement.json'),'utf8'));
const after=JSON.parse(fs.readFileSync(path.join(root,'after-measurement.json'),'utf8'));
if(before.extraction.statements.length!==2||after.extraction.statements.length!==1)throw new Error('SQL copy count changed unexpectedly');
if(!before.extraction.statements.every(s=>s.sqlSha256===after.extraction.statements[0].sqlSha256))throw new Error('SQL bytes differ');
if(JSON.stringify(before.auditedStableAppend)!==JSON.stringify(after.auditedStableAppend))throw new Error('Audited append subtree changed');
console.log(JSON.stringify({native:results,sqlBytesIdentical:true,coreAppendSubtreeUnchanged:true,lexicalDelta:after.extraction.lexicalDelta},null,2));
